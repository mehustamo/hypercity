import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { BuildingPlan, BuildingStyle, CityPlan } from '../types';
import { mulberry32, pick, range, type Rng } from '../utils/random';
import {
  makeAsphaltTexture,
  makeDestinationTexture,
  makeGlowTexture,
  makeHelipadTexture,
  makeRadialFloorTexture,
  makeRingTexture,
  makeSignTexture,
  makeSoftDotTexture,
  makeStorefrontTexture,
  makeWindowArrayTexture,
} from '../utils/textures';
import { CITY_CONSTANTS } from './generateCity';

const dummy = new THREE.Object3D();
const tempColor = new THREE.Color();

const FACADE_VERTEX = /* glsl */ `
  attribute vec2 aGrid;
  attribute float aSeed;
  attribute vec2 aCenter;
  varying vec2 vFacadeUv;
  varying vec2 vGrid;
  varying float vSeed;
  varying vec2 vCenter;
  varying float vFogDepth;

  void main() {
    vFacadeUv = uv;
    vGrid = max(aGrid, vec2(2.0));
    vSeed = aSeed;
    vCenter = aCenter;
    vec4 mvPosition = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
    vFogDepth = -mvPosition.z;
    gl_Position = projectionMatrix * mvPosition;
  }
`;

const FACADE_FRAGMENT = /* glsl */ `
  precision highp float;

  uniform sampler2D uWindowTexture;
  uniform float uNight;
  uniform float uTime;
  uniform float uPulseStart;
  uniform vec2 uPulseOrigin;
  uniform vec3 uFogColor;
  uniform float uFogDensity;

  varying vec2 vFacadeUv;
  varying vec2 vGrid;
  varying float vSeed;
  varying vec2 vCenter;
  varying float vFogDepth;

  void main() {
    // The window pattern lives in a mip-mapped texture. Hardware texture LOD
    // averages the tiny lit cells smoothly as the camera moves away, instead of
    // regenerating them procedurally at sub-pixel sizes and creating moiré.
    // The tile is sampled in exact whole-cell repeats aligned to the facade
    // edges, so no window can be cut off by the building outline.
    vec2 windowUv = vFacadeUv * (vGrid / 16.0);
    vec4 windowSample = texture2D(uWindowTexture, windowUv);
    if (windowSample.a < 0.015) discard;

    vec3 glass = mix(vec3(0.004, 0.009, 0.015), vec3(0.018, 0.045, 0.058), vFacadeUv.y * 0.35);
    float glassBlend = clamp(uNight * 1.08, 0.0, 1.0);
    vec3 color = mix(glass, windowSample.rgb, glassBlend);
    float warmth = smoothstep(0.35, 0.85, fract(vSeed * 0.371));
    color *= mix(vec3(1.0), vec3(1.06, 0.93, 0.8), warmth * uNight);

    float alpha = windowSample.a * mix(0.48, 0.92, uNight);

    float age = max(0.0, uTime - uPulseStart);
    float distanceToCore = distance(vCenter, uPulseOrigin);
    float wave = exp(-pow((distanceToCore - age * 210.0) / 21.0, 2.0)) * exp(-age * 0.22);
    if (age > 5.0) wave = 0.0;
    color += vec3(0.12, 0.8, 1.45) * wave * 0.85;
    alpha = min(1.0, alpha + wave * 0.45);

    float fogFactor = 1.0 - exp(-uFogDensity * uFogDensity * vFogDepth * vFogDepth);
    color = mix(color, uFogColor, fogFactor * 0.9);
    alpha *= 1.0 - fogFactor * 0.72;

    gl_FragColor = vec4(color, alpha);
  }
`;

interface StreetLampPlacement {
  x: number;
  z: number;
  rotation: number;
}

interface WindowUniforms {
  uWindowTexture: { value: THREE.Texture };
  uNight: { value: number };
  uTime: { value: number };
  uPulseStart: { value: number };
  uPulseOrigin: { value: THREE.Vector2 };
  uFogColor: { value: THREE.Color };
  uFogDensity: { value: number };
}

interface DroneState {
  radius: number;
  height: number;
  speed: number;
  phase: number;
  tilt: number;
}

export interface PickResult {
  type: 'building' | 'core';
  building?: BuildingPlan;
}

export class CityWorld {
  readonly group = new THREE.Group();
  readonly plan: CityPlan;
  readonly corePosition: THREE.Vector3;
  readonly landmarkPosition: THREE.Vector3;

  private readonly buildingMeshes: THREE.InstancedMesh[] = [];
  private readonly buildingIdsByMesh = new Map<THREE.InstancedMesh, string[]>();
  private readonly buildingById = new Map<string, BuildingPlan>();
  private readonly windowUniforms: WindowUniforms;

  private asphaltMaterial!: THREE.MeshStandardMaterial;
  private sidewalkMaterial!: THREE.MeshStandardMaterial;
  private roadGlowMaterial!: THREE.MeshBasicMaterial;
  private lampHeadMaterial!: THREE.MeshBasicMaterial;
  private lampGlowMaterial!: THREE.PointsMaterial;
  private lampPoolMaterial!: THREE.MeshBasicMaterial;
  private neonMaterial!: THREE.MeshBasicMaterial;
  private beaconMaterial!: THREE.PointsMaterial;
  private trainWindowMaterial!: THREE.MeshBasicMaterial;
  private droneGlowMaterial!: THREE.PointsMaterial;
  private storefrontMaterial!: THREE.MeshBasicMaterial;
  private storefrontWindowMaterial!: THREE.MeshBasicMaterial;
  private landmarkRibbonMaterial!: THREE.MeshBasicMaterial;
  private selectionMaterial: THREE.LineBasicMaterial | null = null;
  private coreOrb!: THREE.Mesh<THREE.IcosahedronGeometry, THREE.MeshStandardMaterial>;
  private coreLight!: THREE.PointLight;
  private coreRingGroup!: THREE.Group;
  private pulseRings: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>[] = [];
  private pulseStart = -1000;
  private pulseOrigin = new THREE.Vector2(0, 0);
  private elapsed = 0;

  private trainCurve!: THREE.CatmullRomCurve3;
  private trainCars: THREE.Group[] = [];
  private trainT = 0;
  private trainLength = 1;
  private airship!: THREE.Group;
  private airshipAngle = 0;
  private dronePoints!: THREE.Points;
  private droneBody!: THREE.InstancedMesh;
  private droneStates: DroneState[] = [];
  private dronePositions!: Float32Array;
  private dronePositionsAttribute!: THREE.BufferAttribute;

  private selectionHelper: THREE.Box3Helper | null = null;
  private selectionBox = new THREE.Box3();
  private selectedBuildingId: string | null = null;

  constructor(plan: CityPlan) {
    this.plan = plan;
    this.group.name = 'hypercity';
    this.corePosition = new THREE.Vector3(plan.core.x, 14.5, plan.core.z);
    this.landmarkPosition = plan.landmark
      ? new THREE.Vector3(plan.landmark.x, plan.landmark.height * 0.55, plan.landmark.z)
      : new THREE.Vector3(0, 60, 0);

    for (const building of plan.buildings) this.buildingById.set(building.id, building);

    const material = this.makeWindowMaterial();
    this.windowUniforms = material.uniforms as unknown as WindowUniforms;

    this.buildGroundAndRoads();
    this.buildBuildings();
    this.buildFacadeWindows(material);
    this.buildRoofDetails();
    this.buildStreetLights();
    this.buildTrees();
    this.buildPark();
    this.buildCore();
    this.buildSignage();
    this.buildStreetFronts();
    this.buildBackdrop();
    this.buildMonorail();
    this.buildAirship();
    this.buildDrones();
  }

  private makeWindowMaterial(): THREE.ShaderMaterial {
    return new THREE.ShaderMaterial({
      uniforms: {
        uWindowTexture: { value: makeWindowArrayTexture() },
        uNight: { value: 0.25 },
        uTime: { value: 0 },
        uPulseStart: { value: -1000 },
        uPulseOrigin: { value: new THREE.Vector2(0, 0) },
        uFogColor: { value: new THREE.Color(0x08111a) },
        uFogDensity: { value: 0.001 },
      },
      vertexShader: FACADE_VERTEX,
      fragmentShader: FACADE_FRAGMENT,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -4,
      side: THREE.DoubleSide,
      blending: THREE.NormalBlending,
      fog: false,
    });
  }

  get buildingCount(): number {
    return this.plan.buildings.length;
  }

  get selectedId(): string | null {
    return this.selectedBuildingId;
  }

  getBuilding(id: string | null | undefined): BuildingPlan | null {
    if (!id) return null;
    return this.buildingById.get(id) ?? null;
  }

  private buildGroundAndRoads(): void {
    const rng = mulberry32(this.plan.seed ^ 0x9e3779b9);

    const terrainTexture = makeAsphaltTexture();
    terrainTexture.repeat.set(60, 60);
    const terrainMaterial = new THREE.MeshStandardMaterial({
      color: 0x171d1d,
      map: terrainTexture,
      roughness: 1,
      metalness: 0,
    });
    const terrain = new THREE.Mesh(new THREE.PlaneGeometry(2200, 2200), terrainMaterial);
    terrain.rotation.x = -Math.PI / 2;
    terrain.position.y = -0.22;
    terrain.receiveShadow = true;
    this.group.add(terrain);

    const asphaltTexture = makeAsphaltTexture();
    asphaltTexture.repeat.set(72, 72);
    this.asphaltMaterial = new THREE.MeshStandardMaterial({
      color: 0x353c43,
      map: asphaltTexture,
      roughness: 0.9,
      metalness: 0.06,
      envMapIntensity: 0.7,
    });
    const cityBase = new THREE.Mesh(
      new THREE.PlaneGeometry(this.plan.extent * 2 + 36, this.plan.extent * 2 + 36),
      this.asphaltMaterial,
    );
    cityBase.rotation.x = -Math.PI / 2;
    cityBase.receiveShadow = true;
    this.group.add(cityBase);

    this.sidewalkMaterial = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.92,
      metalness: 0.03,
      envMapIntensity: 0.4,
    });
    const blockGeometry = new THREE.BoxGeometry(this.plan.blockSize, 0.26, this.plan.blockSize);
    const sidewalk = new THREE.InstancedMesh(blockGeometry, this.sidewalkMaterial, this.plan.blocks.length);
    sidewalk.receiveShadow = true;
    sidewalk.castShadow = false;
    const sidewalkColors = [0x4b4f52, 0x515356, 0x464b4e, 0x555657, 0x484c4c];
    this.plan.blocks.forEach((block, index) => {
      dummy.position.set(block.x, 0.13, block.z);
      dummy.rotation.set(0, block.kind === 'park' ? 0 : 0, 0);
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      sidewalk.setMatrixAt(index, dummy.matrix);
      sidewalk.setColorAt(index, tempColor.setHex(pick(rng, sidewalkColors)));
    });
    sidewalk.instanceMatrix.needsUpdate = true;
    if (sidewalk.instanceColor) sidewalk.instanceColor.needsUpdate = true;
    this.group.add(sidewalk);

    this.buildRoadMarkings();
  }

  private buildRoadMarkings(): void {
    const rng = mulberry32(this.plan.seed ^ 0x51f15e);
    const roadLines = this.plan.roadLines;
    const markGeometry = new THREE.BoxGeometry(0.19, 0.016, 2.65);
    const markMaterial = new THREE.MeshBasicMaterial({
      color: 0xe3dfc9,
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
    });
    const transforms: THREE.Matrix4[] = [];

    for (let line = 0; line < roadLines.length; line++) {
      const linePos = roadLines[line]!;
      for (let block = 0; block < this.plan.blocksAcross; block++) {
        const blockPos = (block - (this.plan.blocksAcross - 1) / 2) * this.plan.pitch;
        for (const offset of [-14, 0, 14]) {
          // Vertical avenue dashes
          dummy.position.set(linePos, 0.025, blockPos + offset);
          dummy.rotation.set(0, 0, 0);
          dummy.scale.set(1, 1, 1);
          dummy.updateMatrix();
          transforms.push(dummy.matrix.clone());
          // Horizontal avenue dashes
          dummy.position.set(blockPos + offset, 0.025, linePos);
          dummy.rotation.set(0, Math.PI / 2, 0);
          dummy.updateMatrix();
          transforms.push(dummy.matrix.clone());
        }
      }
    }

    const dashes = new THREE.InstancedMesh(markGeometry, markMaterial, transforms.length);
    transforms.forEach((matrix, index) => dashes.setMatrixAt(index, matrix));
    dashes.instanceMatrix.needsUpdate = true;
    dashes.frustumCulled = false;
    this.group.add(dashes);

    // Zebra crossings: four striped bands around each intersection.
    const crosswalkTransforms: THREE.Matrix4[] = [];
    const crossGeometry = new THREE.BoxGeometry(0.55, 0.017, 2.65);
    for (const x of roadLines) {
      for (const z of roadLines) {
        for (const side of [-1, 1]) {
          for (let stripe = -2.5; stripe <= 2.5; stripe++) {
            dummy.position.set(x + stripe * 1.1, 0.032, z + side * 9.4);
            dummy.rotation.set(0, 0, 0);
            dummy.scale.set(1, 1, 1);
            dummy.updateMatrix();
            crosswalkTransforms.push(dummy.matrix.clone());

            dummy.position.set(x + side * 9.4, 0.032, z + stripe * 1.1);
            dummy.rotation.set(0, Math.PI / 2, 0);
            dummy.updateMatrix();
            crosswalkTransforms.push(dummy.matrix.clone());
          }
        }
      }
    }
    const crosswalks = new THREE.InstancedMesh(
      crossGeometry,
      new THREE.MeshBasicMaterial({
        color: 0xc8d4d4,
        transparent: true,
        opacity: 0.38,
        depthWrite: false,
      }),
      crosswalkTransforms.length,
    );
    crosswalkTransforms.forEach((matrix, index) => crosswalks.setMatrixAt(index, matrix));
    crosswalks.instanceMatrix.needsUpdate = true;
    crosswalks.frustumCulled = false;
    this.group.add(crosswalks);

    // A subtle cyan curb glow makes the street lattice legible from the air at night.
    this.roadGlowMaterial = new THREE.MeshBasicMaterial({
      color: 0x58c6d3,
      transparent: true,
      opacity: 0.2,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    });
    const edgeGeometry = new THREE.BoxGeometry(0.11, 0.012, 1);
    const edgeMatrices: THREE.Matrix4[] = [];
    const edgeLength = this.plan.blockSize - 12;
    for (const linePos of roadLines) {
      for (let block = 0; block < this.plan.blocksAcross; block++) {
        const blockPos = (block - (this.plan.blocksAcross - 1) / 2) * this.plan.pitch;
        for (const side of [-1, 1]) {
          dummy.position.set(linePos + side * 6.2, 0.022, blockPos);
          dummy.rotation.set(0, 0, 0);
          dummy.scale.set(1, 1, edgeLength);
          dummy.updateMatrix();
          edgeMatrices.push(dummy.matrix.clone());
          dummy.position.set(blockPos, 0.022, linePos + side * 6.2);
          dummy.rotation.set(0, Math.PI / 2, 0);
          dummy.scale.set(1, 1, edgeLength);
          dummy.updateMatrix();
          edgeMatrices.push(dummy.matrix.clone());
        }
      }
    }
    const edgeGlow = new THREE.InstancedMesh(edgeGeometry, this.roadGlowMaterial, edgeMatrices.length);
    edgeMatrices.forEach((matrix, index) => edgeGlow.setMatrixAt(index, matrix));
    edgeGlow.instanceMatrix.needsUpdate = true;
    edgeGlow.frustumCulled = false;
    this.group.add(edgeGlow);

    // A few warm painted service zones break up the asphalt at the edges.
    for (let i = 0; i < 14; i++) {
      const line = Math.floor(rng() * roadLines.length);
      const x = roadLines[line]!;
      const z = range(rng, -this.plan.extent, this.plan.extent);
      const zone = new THREE.Mesh(
        new THREE.PlaneGeometry(range(rng, 2.2, 4.5), range(rng, 2, 5)),
        new THREE.MeshBasicMaterial({
          color: 0xb29b55,
          transparent: true,
          opacity: 0.13,
          depthWrite: false,
        }),
      );
      zone.rotation.x = -Math.PI / 2;
      zone.position.set(x + range(rng, -5, 5), 0.02, z);
      this.group.add(zone);
    }
  }

  private buildBuildings(): void {
    const styles: BuildingStyle[] = ['glass', 'concrete', 'stone'];
    const styleMaterials: Record<BuildingStyle, THREE.MeshStandardMaterial> = {
      glass: new THREE.MeshStandardMaterial({
        color: 0xffffff,
        roughness: 0.26,
        metalness: 0.56,
        envMapIntensity: 1.45,
      }),
      concrete: new THREE.MeshStandardMaterial({
        color: 0xffffff,
        roughness: 0.8,
        metalness: 0.12,
        envMapIntensity: 0.7,
      }),
      stone: new THREE.MeshStandardMaterial({
        color: 0xffffff,
        roughness: 0.88,
        metalness: 0.04,
        envMapIntensity: 0.5,
      }),
    };

    const counts: Record<BuildingStyle, number> = { glass: 0, concrete: 0, stone: 0 };
    for (const building of this.plan.buildings) {
      for (const volume of building.volumes) counts[volume.style]++;
    }

    const geometry = new THREE.BoxGeometry(1, 1, 1);
    for (const style of styles) {
      if (counts[style] === 0) continue;
      const mesh = new THREE.InstancedMesh(geometry, styleMaterials[style], counts[style]);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
      const ids: string[] = [];
      let cursor = 0;
      for (const building of this.plan.buildings) {
        for (const volume of building.volumes) {
          if (volume.style !== style) continue;
          dummy.position.set(volume.x, volume.y + volume.h / 2, volume.z);
          dummy.rotation.set(0, 0, 0);
          dummy.scale.set(volume.w, volume.h, volume.d);
          dummy.updateMatrix();
          mesh.setMatrixAt(cursor, dummy.matrix);
          mesh.setColorAt(cursor, tempColor.setHex(volume.color));
          ids[cursor] = building.id;
          cursor++;
        }
      }
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.computeBoundingSphere();
      this.group.add(mesh);
      this.buildingMeshes.push(mesh);
      this.buildingIdsByMesh.set(mesh, ids);
    }
  }

  private buildFacadeWindows(material: THREE.ShaderMaterial): void {
    let facadeCount = 0;
    for (const building of this.plan.buildings) facadeCount += building.volumes.length * 4;
    const geometry = new THREE.PlaneGeometry(1, 1);
    const grid = new Float32Array(facadeCount * 2);
    const seeds = new Float32Array(facadeCount);
    const centers = new Float32Array(facadeCount * 2);
    let cursor = 0;

    const addFacade = (
      x: number,
      y: number,
      z: number,
      width: number,
      height: number,
      rotationY: number,
      cols: number,
      rows: number,
      seed: number,
      centerX: number,
      centerZ: number,
    ) => {
      dummy.position.set(x, y, z);
      dummy.rotation.set(0, rotationY, 0);
      dummy.scale.set(width, height, 1);
      dummy.updateMatrix();
      // We collect matrices below using a regular InstancedMesh; attributes align by index.
      facadeMatrices.push(dummy.matrix.clone());
      grid[cursor * 2] = cols;
      grid[cursor * 2 + 1] = rows;
      seeds[cursor] = seed;
      centers[cursor * 2] = centerX;
      centers[cursor * 2 + 1] = centerZ;
      cursor++;
    };
    const facadeMatrices: THREE.Matrix4[] = [];

    for (const building of this.plan.buildings) {
      for (let vi = 0; vi < building.volumes.length; vi++) {
        const volume = building.volumes[vi]!;
        const cols = Math.max(2, Math.round(volume.w / 2.4));
        const rows = Math.max(2, Math.round(volume.h / 2.9));
        const seed = building.seed / 1000 + vi * 13.17;
        const cy = volume.y + volume.h / 2;
        addFacade(
          volume.x,
          cy,
          volume.z + volume.d / 2 + 0.14,
          volume.w,
          volume.h,
          0,
          cols,
          rows,
          seed,
          volume.x,
          volume.z,
        );
        addFacade(
          volume.x,
          cy,
          volume.z - volume.d / 2 - 0.14,
          volume.w,
          volume.h,
          Math.PI,
          cols,
          rows,
          seed,
          volume.x,
          volume.z,
        );
        addFacade(
          volume.x + volume.w / 2 + 0.14,
          cy,
          volume.z,
          volume.d,
          volume.h,
          Math.PI / 2,
          Math.max(2, Math.round(volume.d / 2.4)),
          rows,
          seed + 2.7,
          volume.x,
          volume.z,
        );
        addFacade(
          volume.x - volume.w / 2 - 0.14,
          cy,
          volume.z,
          volume.d,
          volume.h,
          -Math.PI / 2,
          Math.max(2, Math.round(volume.d / 2.4)),
          rows,
          seed + 4.9,
          volume.x,
          volume.z,
        );
      }
    }

    geometry.setAttribute('aGrid', new THREE.InstancedBufferAttribute(grid, 2));
    geometry.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 1));
    geometry.setAttribute('aCenter', new THREE.InstancedBufferAttribute(centers, 2));
    const mesh = new THREE.InstancedMesh(geometry, material, facadeCount);
    facadeMatrices.forEach((matrix, index) => mesh.setMatrixAt(index, matrix));
    mesh.instanceMatrix.needsUpdate = true;
    mesh.frustumCulled = false;
    mesh.renderOrder = 3;
    this.group.add(mesh);
  }

  private buildRoofDetails(): void {
    const rng = mulberry32(this.plan.seed ^ 0xa11ce);
    const topVolumes = this.plan.buildings.map((building) => ({
      building,
      volume: building.volumes[building.volumes.length - 1]!,
    }));

    // Rooftop mechanical plant.
    const acCount = topVolumes.filter(({ building }) => building.w * building.d > 110).length * 2;
    const acGeometry = new THREE.BoxGeometry(1, 1, 1);
    const acMaterial = new THREE.MeshStandardMaterial({
      color: 0x242a30,
      roughness: 0.74,
      metalness: 0.26,
    });
    const acMeshes = new THREE.InstancedMesh(acGeometry, acMaterial, Math.max(acCount, 1));
    let acCursor = 0;
    for (const { building, volume } of topVolumes) {
      if (building.w * building.d <= 110) continue;
      for (let i = 0; i < 2; i++) {
        const top = volume.y + volume.h;
        const w = range(rng, 1.2, 3.4);
        const h = range(rng, 0.5, 1.65);
        const d = range(rng, 1.2, 3);
        dummy.position.set(
          volume.x + range(rng, -volume.w / 2 + 2, volume.w / 2 - 2),
          top + h / 2,
          volume.z + range(rng, -volume.d / 2 + 2, volume.d / 2 - 2),
        );
        dummy.rotation.set(0, range(rng, 0, Math.PI), 0);
        dummy.scale.set(w, h, d);
        dummy.updateMatrix();
        acMeshes.setMatrixAt(acCursor++, dummy.matrix);
      }
    }
    acMeshes.count = acCursor;
    acMeshes.instanceMatrix.needsUpdate = true;
    acMeshes.castShadow = true;
    this.group.add(acMeshes);

    // Antennas.
    const antennas = topVolumes.filter(({ building }) => building.hasAntenna);
    const antennaGeometry = new THREE.CylinderGeometry(0.09, 0.16, 1, 5);
    const antennaMaterial = new THREE.MeshStandardMaterial({
      color: 0x323b42,
      roughness: 0.55,
      metalness: 0.62,
    });
    const antennaMesh = new THREE.InstancedMesh(antennaGeometry, antennaMaterial, Math.max(antennas.length, 1));
    const beaconPositions: number[] = [];
    antennas.forEach(({ building, volume }, index) => {
      const height = range(rng, 5, building.height > 120 ? 24 : 13);
      const top = volume.y + volume.h;
      dummy.position.set(volume.x, top + height / 2, volume.z);
      dummy.rotation.set(0, 0, 0);
      dummy.scale.set(1, height, 1);
      dummy.updateMatrix();
      antennaMesh.setMatrixAt(index, dummy.matrix);
      beaconPositions.push(volume.x, top + height, volume.z);
    });
    antennaMesh.count = antennas.length;
    antennaMesh.instanceMatrix.needsUpdate = true;
    antennaMesh.castShadow = true;
    this.group.add(antennaMesh);

    for (const { building, volume } of topVolumes) {
      if (building.hasBeacon && !building.hasAntenna) {
        beaconPositions.push(volume.x, volume.y + volume.h + 0.25, volume.z);
      }
    }
    this.beaconMaterial = new THREE.PointsMaterial({
      color: 0xff4e5c,
      map: makeGlowTexture(64),
      size: 3.6,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      sizeAttenuation: true,
      toneMapped: false,
    });
    const beacons = new THREE.Points(
      new THREE.BufferGeometry().setAttribute(
        'position',
        new THREE.Float32BufferAttribute(beaconPositions, 3),
      ),
      this.beaconMaterial,
    );
    beacons.frustumCulled = false;
    this.group.add(beacons);

    // Helipads.
    const helipads = topVolumes.filter(({ building }) => building.hasHelipad);
    if (helipads.length) {
      const geometry = new THREE.PlaneGeometry(11, 11);
      const material = new THREE.MeshBasicMaterial({
        map: makeHelipadTexture(),
        transparent: true,
        depthWrite: false,
        toneMapped: false,
      });
      const mesh = new THREE.InstancedMesh(geometry, material, helipads.length);
      helipads.forEach(({ volume }, index) => {
        dummy.position.set(volume.x, volume.y + volume.h + 0.04, volume.z);
        dummy.rotation.set(-Math.PI / 2, 0, 0);
        dummy.scale.set(1, 1, 1);
        dummy.updateMatrix();
        mesh.setMatrixAt(index, dummy.matrix);
      });
      mesh.instanceMatrix.needsUpdate = true;
      this.group.add(mesh);
    }

    // Neon roof bands are a strong late-night read from above.
    const neonBuildings = this.plan.buildings.filter((building) => building.hasNeonBand);
    const neonGeometry = new THREE.BoxGeometry(1, 0.16, 0.16);
    this.neonMaterial = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.6,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    });
    const neonMesh = new THREE.InstancedMesh(neonGeometry, this.neonMaterial, neonBuildings.length * 4);
    let neonCursor = 0;
    for (const building of neonBuildings) {
      const volume = building.volumes[building.volumes.length - 1]!;
      const top = volume.y + volume.h + 0.12;
      const width = volume.w + 0.12;
      const depth = volume.d + 0.12;
      const strips = [
        { x: volume.x, z: volume.z + depth / 2, sx: width, sy: 0 },
        { x: volume.x, z: volume.z - depth / 2, sx: width, sy: 0 },
        { x: volume.x + width / 2, z: volume.z, sx: depth, sy: Math.PI / 2 },
        { x: volume.x - width / 2, z: volume.z, sx: depth, sy: Math.PI / 2 },
      ];
      for (const strip of strips) {
        dummy.position.set(strip.x, top, strip.z);
        dummy.rotation.set(0, strip.sy, 0);
        dummy.scale.set(strip.sx, 1, 1);
        dummy.updateMatrix();
        neonMesh.setMatrixAt(neonCursor, dummy.matrix);
        neonMesh.setColorAt(neonCursor, tempColor.setHex(building.neonColor).multiplyScalar(1.35));
        neonCursor++;
      }
    }
    neonMesh.instanceMatrix.needsUpdate = true;
    if (neonMesh.instanceColor) neonMesh.instanceColor.needsUpdate = true;
    this.group.add(neonMesh);

    // The hero tower gets an explicit crown, independent of its window strips.
    const landmark = this.plan.landmark;
    if (landmark) {
      const crownGroup = new THREE.Group();
      const top = landmark.height + 1;
      const colors = [0x63e6ff, 0x9d7bff, 0x63e6ff];
      for (let ring = 0; ring < 3; ring++) {
        const radius = 8.5 - ring * 2.2;
        const geometry = new THREE.TorusGeometry(radius, 0.1, 6, 64);
        const material = new THREE.MeshBasicMaterial({
          color: colors[ring]!,
          transparent: true,
          opacity: 0.8,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
          toneMapped: false,
        });
        const torus = new THREE.Mesh(geometry, material);
        torus.position.set(landmark.x, top + ring * 4.2, landmark.z);
        torus.rotation.x = Math.PI / 2;
        crownGroup.add(torus);
      }
      const beacon = new THREE.Mesh(
        new THREE.SphereGeometry(0.38, 8, 6),
        new THREE.MeshBasicMaterial({ color: 0xff7080, toneMapped: false }),
      );
      beacon.position.set(landmark.x, landmark.volumes[landmark.volumes.length - 1]!.y + landmark.volumes[landmark.volumes.length - 1]!.h + (landmark.hasAntenna ? 24 : 12), landmark.z);
      crownGroup.add(beacon);
      this.group.add(crownGroup);
    }
  }

  private buildStreetLights(): void {
    const placements: StreetLampPlacement[] = [];
    for (const block of this.plan.blocks) {
      if (block.kind === 'core') continue;
      const inset = this.plan.blockSize / 2 - 1.2;
      placements.push({
        x: block.x - inset,
        z: block.z - inset,
        rotation: Math.PI * 0.5,
      });
      placements.push({
        x: block.x + inset,
        z: block.z + inset,
        rotation: Math.PI * 0.5,
      });
    }

    const poleParts = [
      new THREE.BoxGeometry(0.15, 5.35, 0.15).translate(0, 2.675, 0),
      new THREE.BoxGeometry(2.9, 0.1, 0.12).translate(0, 5.32, 0),
    ];
    const poleGeometry = mergeGeometries(poleParts)!;
    const poleMaterial = new THREE.MeshStandardMaterial({
      color: 0x242a30,
      roughness: 0.52,
      metalness: 0.62,
    });
    const poles = new THREE.InstancedMesh(poleGeometry, poleMaterial, placements.length);
    poles.frustumCulled = false;
    this.group.add(poles);

    this.lampHeadMaterial = new THREE.MeshBasicMaterial({
      color: 0xffc984,
      transparent: true,
      opacity: 0.45,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    });
    const capParts = [
      new THREE.BoxGeometry(0.58, 0.18, 0.32).translate(-1.23, 5.27, 0),
      new THREE.BoxGeometry(0.58, 0.18, 0.32).translate(1.23, 5.27, 0),
    ];
    const capGeometry = mergeGeometries(capParts)!;
    const caps = new THREE.InstancedMesh(capGeometry, this.lampHeadMaterial, placements.length);
    caps.frustumCulled = false;
    this.group.add(caps);

    const glowPositions: number[] = [];
    const poolPositions: number[] = [];
    placements.forEach((placement, index) => {
      dummy.position.set(placement.x, 0, placement.z);
      dummy.rotation.set(0, placement.rotation, 0);
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      poles.setMatrixAt(index, dummy.matrix);
      caps.setMatrixAt(index, dummy.matrix);
      poolPositions.push(placement.x, 0.055, placement.z);
      const cos = Math.cos(placement.rotation);
      const sin = Math.sin(placement.rotation);
      for (const side of [-1, 1]) {
        const localX = side * 1.23;
        glowPositions.push(
          placement.x + cos * localX,
          5.27,
          placement.z - sin * localX,
        );
      }
    });
    poles.instanceMatrix.needsUpdate = true;
    caps.instanceMatrix.needsUpdate = true;

    this.lampGlowMaterial = new THREE.PointsMaterial({
      color: 0xffbd7c,
      map: makeGlowTexture(),
      size: 4.2,
      transparent: true,
      opacity: 0.45,
      depthWrite: false,
      sizeAttenuation: true,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    });
    const glows = new THREE.Points(
      new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(glowPositions, 3)),
      this.lampGlowMaterial,
    );
    glows.frustumCulled = false;
    this.group.add(glows);

    this.lampPoolMaterial = new THREE.MeshBasicMaterial({
      color: 0xffa95f,
      map: makeRadialFloorTexture(),
      transparent: true,
      opacity: 0.14,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    });
    const poolGeometry = new THREE.PlaneGeometry(13, 13);
    const pools = new THREE.InstancedMesh(poolGeometry, this.lampPoolMaterial, placements.length);
    placements.forEach((placement, index) => {
      dummy.position.set(placement.x, 0.055, placement.z);
      dummy.rotation.set(-Math.PI / 2, 0, 0);
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      pools.setMatrixAt(index, dummy.matrix);
    });
    pools.instanceMatrix.needsUpdate = true;
    pools.frustumCulled = false;
    this.group.add(pools);
  }

  private buildTrees(): void {
    const rng = mulberry32(this.plan.seed ^ 0x7ee5);
    const trees = this.plan.trees;
    const trunkGeometry = new THREE.CylinderGeometry(0.16, 0.28, 1, 5);
    trunkGeometry.translate(0, 0.5, 0);
    const trunkMaterial = new THREE.MeshStandardMaterial({
      color: 0x33261f,
      roughness: 0.94,
      metalness: 0,
    });
    const trunks = new THREE.InstancedMesh(trunkGeometry, trunkMaterial, trees.length);

    const foliageGeometry = new THREE.IcosahedronGeometry(1, 1);
    const foliageMaterial = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.88,
      metalness: 0,
      flatShading: true,
    });
    const lowerFoliage = new THREE.InstancedMesh(foliageGeometry, foliageMaterial, trees.length);
    const upperFoliage = new THREE.InstancedMesh(foliageGeometry, foliageMaterial, trees.length);
    lowerFoliage.castShadow = true;
    upperFoliage.castShadow = true;

    trees.forEach((tree, index) => {
      const s = tree.scale;
      const baseY = this.plan.blocks.find((block) => block.kind === 'park' && Math.abs(block.x - tree.x) < 22 && Math.abs(block.z - tree.z) < 22)
        ? 0.3
        : 0.26;
      dummy.position.set(tree.x, baseY, tree.z);
      dummy.rotation.set(0, rng() * Math.PI * 2, 0);
      dummy.scale.set(s, s * 2.7, s);
      dummy.updateMatrix();
      trunks.setMatrixAt(index, dummy.matrix);

      dummy.position.set(tree.x, baseY + 2.5 * s, tree.z);
      dummy.rotation.set(0, rng() * Math.PI * 2, 0);
      dummy.scale.set(1.65 * s, 2.35 * s, 1.65 * s);
      dummy.updateMatrix();
      lowerFoliage.setMatrixAt(index, dummy.matrix);
      tempColor.setHSL(0.285 + rng() * 0.035, 0.27 + rng() * 0.12, 0.16 + rng() * 0.07);
      lowerFoliage.setColorAt(index, tempColor);

      dummy.position.set(tree.x + 0.35 * s, baseY + 4.0 * s, tree.z - 0.2 * s);
      dummy.rotation.set(0, rng() * Math.PI * 2, 0);
      dummy.scale.set(1.2 * s, 1.7 * s, 1.2 * s);
      dummy.updateMatrix();
      upperFoliage.setMatrixAt(index, dummy.matrix);
      tempColor.setHSL(0.29 + rng() * 0.04, 0.3, 0.2 + rng() * 0.08);
      upperFoliage.setColorAt(index, tempColor);
    });
    trunks.instanceMatrix.needsUpdate = true;
    lowerFoliage.instanceMatrix.needsUpdate = true;
    upperFoliage.instanceMatrix.needsUpdate = true;
    if (lowerFoliage.instanceColor) lowerFoliage.instanceColor.needsUpdate = true;
    if (upperFoliage.instanceColor) upperFoliage.instanceColor.needsUpdate = true;
    this.group.add(trunks, lowerFoliage, upperFoliage);
  }

  private buildPark(): void {
    const park = this.plan.park;
    const grass = new THREE.Mesh(
      new THREE.PlaneGeometry(this.plan.blockSize - 2.8, this.plan.blockSize - 2.8),
      new THREE.MeshStandardMaterial({
        color: 0x213d2e,
        roughness: 0.96,
        metalness: 0,
      }),
    );
    grass.rotation.x = -Math.PI / 2;
    grass.position.set(park.x, 0.302, park.z);
    grass.receiveShadow = true;
    this.group.add(grass);

    const path = new THREE.Mesh(
      new THREE.RingGeometry(7.0, 8.45, 64),
      new THREE.MeshStandardMaterial({ color: 0x8b806c, roughness: 0.89, metalness: 0.02 }),
    );
    path.rotation.x = -Math.PI / 2;
    path.position.set(park.x, 0.316, park.z);
    path.receiveShadow = true;
    this.group.add(path);

    const pond = new THREE.Mesh(
      new THREE.CircleGeometry(5.2, 64),
      new THREE.MeshPhysicalMaterial({
        color: 0x092b37,
        roughness: 0.08,
        metalness: 0.32,
        clearcoat: 1,
        clearcoatRoughness: 0.08,
      }),
    );
    pond.rotation.x = -Math.PI / 2;
    pond.position.set(park.x, 0.33, park.z);
    this.group.add(pond);

    const rim = new THREE.Mesh(
      new THREE.TorusGeometry(5.35, 0.16, 6, 64),
      new THREE.MeshStandardMaterial({ color: 0x68665b, roughness: 0.82 }),
    );
    rim.rotation.x = Math.PI / 2;
    rim.position.set(park.x, 0.34, park.z);
    this.group.add(rim);

    const fountainBase = new THREE.Mesh(
      new THREE.CylinderGeometry(1.45, 1.85, 0.65, 16),
      new THREE.MeshStandardMaterial({ color: 0x2c3334, roughness: 0.6, metalness: 0.22 }),
    );
    fountainBase.position.set(park.x, 0.67, park.z);
    this.group.add(fountainBase);
    const fountainSculpture = new THREE.Mesh(
      new THREE.IcosahedronGeometry(0.62, 1),
      new THREE.MeshBasicMaterial({ color: 0x88ecff, toneMapped: false }),
    );
    fountainSculpture.position.set(park.x, 2.05, park.z);
    this.group.add(fountainSculpture);

    const seatGeometryParts = [
      new THREE.BoxGeometry(2.3, 0.16, 0.64).translate(0, 0.52, 0),
      new THREE.BoxGeometry(2.3, 0.64, 0.12).translate(0, 0.85, -0.28),
      new THREE.BoxGeometry(0.12, 0.5, 0.56).translate(-0.88, 0.27, 0),
      new THREE.BoxGeometry(0.12, 0.5, 0.56).translate(0.88, 0.27, 0),
    ];
    const seatGeometry = mergeGeometries(seatGeometryParts)!;
    const seatMaterial = new THREE.MeshStandardMaterial({
      color: 0x4c392d,
      roughness: 0.78,
      metalness: 0.16,
    });
    const benches = new THREE.InstancedMesh(seatGeometry, seatMaterial, 10);
    for (let i = 0; i < 10; i++) {
      const angle = (i / 10) * Math.PI * 2;
      const radius = 7.8;
      dummy.position.set(park.x + Math.cos(angle) * radius, 0.32, park.z + Math.sin(angle) * radius);
      dummy.rotation.set(0, Math.atan2(-Math.cos(angle), -Math.sin(angle)), 0);
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      benches.setMatrixAt(i, dummy.matrix);
    }
    benches.instanceMatrix.needsUpdate = true;
    benches.castShadow = true;
    this.group.add(benches);
  }

  private buildCore(): void {
    const core = this.plan.core;
    const plaza = new THREE.Group();
    plaza.position.set(core.x, 0, core.z);

    const platform = new THREE.Mesh(
      new THREE.CylinderGeometry(17.4, 17.8, 0.24, 64),
      new THREE.MeshStandardMaterial({
        color: 0x1c252b,
        roughness: 0.29,
        metalness: 0.52,
        envMapIntensity: 1.2,
      }),
    );
    platform.position.y = 0.36;
    platform.receiveShadow = true;
    plaza.add(platform);

    const glow = new THREE.Mesh(
      new THREE.PlaneGeometry(34, 34),
      new THREE.MeshBasicMaterial({
        map: makeRadialFloorTexture(),
        color: 0x49dfff,
        transparent: true,
        opacity: 0.48,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        toneMapped: false,
      }),
    );
    glow.rotation.x = -Math.PI / 2;
    glow.position.y = 0.5;
    plaza.add(glow);

    const outerRing = new THREE.Mesh(
      new THREE.TorusGeometry(15.6, 0.08, 6, 128),
      new THREE.MeshBasicMaterial({
        color: 0x63e6ff,
        transparent: true,
        opacity: 0.8,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        toneMapped: false,
      }),
    );
    outerRing.rotation.x = Math.PI / 2;
    outerRing.position.y = 0.5;
    plaza.add(outerRing);

    const innerRing = new THREE.Mesh(
      new THREE.TorusGeometry(9.2, 0.04, 6, 96),
      new THREE.MeshBasicMaterial({
        color: 0x9d7bff,
        transparent: true,
        opacity: 0.65,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        toneMapped: false,
      }),
    );
    innerRing.rotation.x = Math.PI / 2;
    innerRing.position.y = 0.51;
    plaza.add(innerRing);

    const pedestal = new THREE.Mesh(
      new THREE.CylinderGeometry(2.1, 2.8, 1.2, 24),
      new THREE.MeshStandardMaterial({ color: 0x23343d, roughness: 0.35, metalness: 0.7 }),
    );
    pedestal.position.y = 1.02;
    plaza.add(pedestal);

    this.coreOrb = new THREE.Mesh(
      new THREE.IcosahedronGeometry(3.9, 2),
      new THREE.MeshStandardMaterial({
        color: 0x61ddff,
        emissive: 0x1c8fae,
        emissiveIntensity: 2.4,
        roughness: 0.16,
        metalness: 0.42,
      }),
    );
    this.coreOrb.position.y = 14.5;
    plaza.add(this.coreOrb);

    const wire = new THREE.Mesh(
      new THREE.IcosahedronGeometry(5.8, 1),
      new THREE.MeshBasicMaterial({
        color: 0x73eaff,
        wireframe: true,
        transparent: true,
        opacity: 0.22,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        toneMapped: false,
      }),
    );
    wire.position.y = 14.5;
    plaza.add(wire);

    this.coreRingGroup = new THREE.Group();
    this.coreRingGroup.position.y = 14.5;
    const ringColors = [0x63e6ff, 0x9d7bff, 0x63e6ff];
    for (let i = 0; i < 3; i++) {
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(7.1 + i * 1.4, 0.055, 5, 96),
        new THREE.MeshBasicMaterial({
          color: ringColors[i]!,
          transparent: true,
          opacity: 0.73,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
          toneMapped: false,
        }),
      );
      ring.rotation.set(0.45 + i * 0.48, i * 0.75, 0.2 + i * 0.3);
      this.coreRingGroup.add(ring);
    }
    for (let i = 0; i < 2; i++) {
      const halo = new THREE.Mesh(
        new THREE.TorusGeometry(i === 0 ? 12.2 : 8.4, 0.06, 5, 96),
        new THREE.MeshBasicMaterial({
          color: i === 0 ? 0x7cecff : 0xb594ff,
          transparent: true,
          opacity: 0.5,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
          toneMapped: false,
        }),
      );
      halo.rotation.x = Math.PI / 2;
      halo.position.y = i === 0 ? 20 : 32;
      this.coreRingGroup.add(halo);
    }
    for (let i = 0; i < 2; i++) {
      const halo = new THREE.Mesh(
        new THREE.TorusGeometry(i === 0 ? 24 : 15, 0.075, 5, 128),
        new THREE.MeshBasicMaterial({
          color: i === 0 ? 0x5edfff : 0x9d7bff,
          transparent: true,
          opacity: i === 0 ? 0.24 : 0.2,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
          toneMapped: false,
        }),
      );
      halo.rotation.x = Math.PI / 2;
      halo.position.y = i === 0 ? 42 : 54;
      this.coreRingGroup.add(halo);
    }
    plaza.add(this.coreRingGroup);

    const beam = new THREE.Mesh(
      new THREE.CylinderGeometry(0.07, 5.2, 90, 20, 1, true),
      new THREE.MeshBasicMaterial({
        color: 0x54dfff,
        transparent: true,
        opacity: 0.055,
        depthWrite: false,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
        toneMapped: false,
      }),
    );
    beam.position.y = 47;
    plaza.add(beam);

    const sparkCount = 120;
    const sparkPositions = new Float32Array(sparkCount * 3);
    const sparkSeed = mulberry32(this.plan.seed ^ 0x51a4);
    for (let i = 0; i < sparkCount; i++) {
      const angle = sparkSeed() * Math.PI * 2;
      const radius = range(sparkSeed, 4.2, 11.8);
      sparkPositions[i * 3] = Math.cos(angle) * radius;
      sparkPositions[i * 3 + 1] = 14.5 + range(sparkSeed, -6.5, 7.5);
      sparkPositions[i * 3 + 2] = Math.sin(angle) * radius;
    }
    const sparks = new THREE.Points(
      new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(sparkPositions, 3)),
      new THREE.PointsMaterial({
        color: 0x9ef3ff,
        map: makeSoftDotTexture(),
        size: 0.6,
        transparent: true,
        opacity: 0.8,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        sizeAttenuation: true,
        toneMapped: false,
      }),
    );
    sparks.frustumCulled = false;
    plaza.add(sparks);

    this.coreLight = new THREE.PointLight(0x58dcff, 380, 110, 2);
    this.coreLight.position.set(0, 13, 0);
    plaza.add(this.coreLight);

    this.group.add(plaza);

    for (let i = 0; i < 3; i++) {
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(1, 1.025, 96),
        new THREE.MeshBasicMaterial({
          color: i === 1 ? 0x9d7bff : 0x7debff,
          transparent: true,
          opacity: 0,
          depthWrite: false,
          side: THREE.DoubleSide,
          blending: THREE.AdditiveBlending,
          toneMapped: false,
        }),
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 0.54;
      ring.visible = false;
      this.pulseRings.push(ring);
      this.group.add(ring);
    }
  }

  private buildSignage(): void {
    const candidates = this.plan.buildings
      .filter((building) => building.height > 64 && building.volumes[0]!.w > 12)
      .sort((a, b) => b.height - a.height);
    const chosen: BuildingPlan[] = [];
    if (this.plan.landmark) chosen.push(this.plan.landmark);
    for (const candidate of candidates) {
      if (chosen.length >= 5) break;
      if (candidate.landmark) continue;
      if (chosen.some((building) => Math.abs(building.x - candidate.x) < 60 && Math.abs(building.z - candidate.z) < 60)) {
        continue;
      }
      chosen.push(candidate);
    }

    const signs = [
      { title: 'DEEPSEEK', subtitle: 'NEURAL INFRASTRUCTURE // 24H', accent: '#68eaff' },
      { title: 'HELIX', subtitle: 'BIO-SYNTH DIVISION', accent: '#ff9f68' },
      { title: 'SIGNAL 07', subtitle: 'CITYWIDE BROADCAST', accent: '#ff6fd4' },
      { title: 'NOVA', subtitle: 'ENERGY FOR EVERY SECTOR', accent: '#a88bff' },
      { title: 'PARALLAX', subtitle: 'THE CITY IS THE MACHINE', accent: '#7dffc4' },
    ];

    chosen.forEach((building, index) => {
      const base = building.volumes[0]!;
      const spec = signs[index % signs.length]!;
      const width = Math.min(16, base.w * 0.8);
      const height = width * 0.46;
      const centerY = Math.min(base.y + base.h * 0.68, Math.max(14, building.height * 0.42));
      const useXFace = index % 2 === 1;
      const texture = makeSignTexture({
        title: spec.title,
        subtitle: spec.subtitle,
        accent: spec.accent,
        width: 1024,
        height: 472,
        align: 'left',
      });
      const signMaterial = new THREE.MeshBasicMaterial({
        map: texture,
        toneMapped: true,
      });
      signMaterial.color.setRGB(1.22, 1.22, 1.22);
      const sign = new THREE.Mesh(new THREE.PlaneGeometry(width, height), signMaterial);
      const frame = new THREE.Mesh(
        new THREE.BoxGeometry(width + 0.7, height + 0.7, 0.24),
        new THREE.MeshStandardMaterial({ color: 0x0d151c, roughness: 0.44, metalness: 0.62 }),
      );
      if (useXFace) {
        sign.rotation.y = Math.PI / 2;
        frame.rotation.y = Math.PI / 2;
        sign.position.set(
          base.x + base.w / 2 + 0.2,
          centerY,
          base.z,
        );
        frame.position.set(
          base.x + base.w / 2 + 0.04,
          centerY,
          base.z,
        );
      } else {
        sign.position.set(base.x, centerY, base.z + base.d / 2 + 0.2);
        frame.position.set(base.x, centerY, base.z + base.d / 2 + 0.04);
      }
      sign.renderOrder = 4;
      this.group.add(frame, sign);
    });
  }

  private buildStreetFronts(): void {
    const rng = mulberry32(this.plan.seed ^ 0x51ee7);
    const facadeCount = this.plan.buildings.length * 4;
    const material = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.5,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -4,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    });
    this.storefrontMaterial = material;
    const mesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), material, facadeCount);
    mesh.frustumCulled = false;
    const shopMaterial = new THREE.MeshBasicMaterial({
      map: makeStorefrontTexture(),
      color: 0xffc18a,
      transparent: true,
      opacity: 0.34,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -4,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    });
    this.storefrontWindowMaterial = shopMaterial;
    const shops = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), shopMaterial, facadeCount);
    shops.frustumCulled = false;
    shops.renderOrder = 2;
    const accentColors = [0xffb36b, 0x6be7ff, 0xa88bff, 0xff7bc6, 0xffd08a, 0x6bffcf];
    let cursor = 0;
    let shopCursor = 0;
    for (const building of this.plan.buildings) {
      const base = building.volumes[0]!;
      const color = rng() < 0.68
        ? 0xffb36b
        : accentColors[Math.floor(rng() * accentColors.length)]!;
      const width = base.w * 0.68;
      const depth = base.d * 0.68;
      const y = base.y + 3.15;
      const placements = [
        { x: base.x, z: base.z + base.d / 2 + 0.08, w: width, rot: 0 },
        { x: base.x, z: base.z - base.d / 2 - 0.08, w: width, rot: Math.PI },
        { x: base.x + base.w / 2 + 0.08, z: base.z, w: depth, rot: Math.PI / 2 },
        { x: base.x - base.w / 2 - 0.08, z: base.z, w: depth, rot: -Math.PI / 2 },
      ];
      for (const placement of placements) {
        dummy.position.set(placement.x, y, placement.z);
        dummy.rotation.set(0, placement.rot, 0);
        dummy.scale.set(placement.w, 0.26, 1);
        dummy.updateMatrix();
        mesh.setMatrixAt(cursor, dummy.matrix);
        mesh.setColorAt(cursor, tempColor.setHex(color).multiplyScalar(0.72));
        cursor++;

        dummy.position.set(placement.x, base.y + 1.72, placement.z);
        dummy.rotation.set(0, placement.rot, 0);
        dummy.scale.set(placement.w * 1.1, 2.85, 1);
        dummy.updateMatrix();
        shops.setMatrixAt(shopCursor, dummy.matrix);
        shops.setColorAt(shopCursor, tempColor.setHex(rng() < 0.72 ? 0xffc18a : color).multiplyScalar(0.58));
        shopCursor++;
      }
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    shops.instanceMatrix.needsUpdate = true;
    if (shops.instanceColor) shops.instanceColor.needsUpdate = true;
    this.group.add(mesh, shops);

    const landmark = this.plan.landmark;
    if (!landmark) return;
    this.landmarkRibbonMaterial = new THREE.MeshBasicMaterial({
      color: 0x6deaff,
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    });
    const ribbonGeometry = new THREE.BoxGeometry(0.13, 1, 0.13);
    const ribbons = new THREE.InstancedMesh(
      ribbonGeometry,
      this.landmarkRibbonMaterial,
      landmark.volumes.length * 4,
    );
    ribbons.frustumCulled = false;
    let ribbonCursor = 0;
    for (const volume of landmark.volumes) {
      const y = volume.y + volume.h / 2;
      for (const sx of [-1, 1]) {
        for (const sz of [-1, 1]) {
          dummy.position.set(
            volume.x + sx * (volume.w / 2 - 0.15),
            y,
            volume.z + sz * (volume.d / 2 - 0.15),
          );
          dummy.rotation.set(0, 0, 0);
          dummy.scale.set(1, volume.h * 0.94, 1);
          dummy.updateMatrix();
          ribbons.setMatrixAt(ribbonCursor++, dummy.matrix);
        }
      }
    }
    ribbons.instanceMatrix.needsUpdate = true;
    this.group.add(ribbons);
  }

  private buildBackdrop(): void {
    const rng = mulberry32(this.plan.seed ^ 0xba5eba11);
    const count = 220;
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    const material = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.94,
      metalness: 0.12,
      envMapIntensity: 0.25,
    });
    const backdrop = new THREE.InstancedMesh(geometry, material, count);
    for (let i = 0; i < count; i++) {
      const angle = rng() * Math.PI * 2;
      const radius = range(rng, 405, 860);
      const width = range(rng, 14, 44);
      const depth = range(rng, 16, 54);
      const height = range(rng, 14, 95);
      dummy.position.set(Math.cos(angle) * radius, height / 2 - 0.2, Math.sin(angle) * radius);
      dummy.rotation.set(0, range(rng, 0, Math.PI), 0);
      dummy.scale.set(width, height, depth);
      dummy.updateMatrix();
      backdrop.setMatrixAt(i, dummy.matrix);
      backdrop.setColorAt(i, tempColor.setHSL(0.56 + rng() * 0.035, 0.16, 0.075 + rng() * 0.045));
    }
    backdrop.instanceMatrix.needsUpdate = true;
    if (backdrop.instanceColor) backdrop.instanceColor.needsUpdate = true;
    backdrop.castShadow = false;
    backdrop.receiveShadow = false;
    this.group.add(backdrop);
  }

  private buildMonorail(): void {
    const points = [
      new THREE.Vector3(-140, 14, -56),
      new THREE.Vector3(-140, 14, 56),
      new THREE.Vector3(-112, 14, 112),
      new THREE.Vector3(-56, 14, 140),
      new THREE.Vector3(56, 14, 140),
      new THREE.Vector3(112, 14, 112),
      new THREE.Vector3(140, 14, 56),
      new THREE.Vector3(140, 14, -56),
      new THREE.Vector3(112, 14, -112),
      new THREE.Vector3(56, 14, -140),
      new THREE.Vector3(-56, 14, -140),
      new THREE.Vector3(-112, 14, -112),
    ];
    this.trainCurve = new THREE.CatmullRomCurve3(points, true, 'catmullrom', 0.32);
    this.trainLength = this.trainCurve.getLength();

    const trackMaterial = new THREE.MeshStandardMaterial({
      color: 0x4e5b63,
      roughness: 0.35,
      metalness: 0.78,
      envMapIntensity: 1.2,
    });
    const track = new THREE.Mesh(
      new THREE.TubeGeometry(this.trainCurve, 300, 0.5, 6, true),
      trackMaterial,
    );
    track.castShadow = true;
    track.receiveShadow = true;
    this.group.add(track);

    const linePoints = this.trainCurve.getPoints(320).map((point) => point.clone().add(new THREE.Vector3(0, 0.55, 0)));
    const glowLine = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(linePoints),
      new THREE.LineBasicMaterial({
        color: 0x63e6ff,
        transparent: true,
        opacity: 0.7,
        blending: THREE.AdditiveBlending,
        toneMapped: false,
      }),
    );
    this.group.add(glowLine);

    const supportGeometry = new THREE.CylinderGeometry(0.38, 0.62, 1, 6);
    const supportMaterial = new THREE.MeshStandardMaterial({
      color: 0x414b51,
      roughness: 0.5,
      metalness: 0.65,
    });
    const supportCount = 32;
    const supports = new THREE.InstancedMesh(supportGeometry, supportMaterial, supportCount);
    for (let i = 0; i < supportCount; i++) {
      const point = this.trainCurve.getPointAt(i / supportCount);
      dummy.position.set(point.x, point.y / 2, point.z);
      dummy.rotation.set(0, 0, 0);
      dummy.scale.set(1, point.y, 1);
      dummy.updateMatrix();
      supports.setMatrixAt(i, dummy.matrix);
    }
    supports.instanceMatrix.needsUpdate = true;
    supports.castShadow = true;
    this.group.add(supports);

    const bodyMaterial = new THREE.MeshStandardMaterial({
      color: 0xbecbd0,
      roughness: 0.27,
      metalness: 0.7,
      envMapIntensity: 1.3,
    });
    const darkMaterial = new THREE.MeshStandardMaterial({
      color: 0x1c2328,
      roughness: 0.3,
      metalness: 0.6,
    });
    this.trainWindowMaterial = new THREE.MeshBasicMaterial({
      color: 0x95f3ff,
      transparent: true,
      opacity: 0.8,
      depthWrite: false,
      toneMapped: false,
    });
    const headlightMaterial = new THREE.MeshBasicMaterial({
      color: 0xfff4d6,
      toneMapped: false,
    });

    for (let i = 0; i < 3; i++) {
      const car = new THREE.Group();
      const body = new THREE.Mesh(new THREE.BoxGeometry(2.75, 1.9, 9.25), bodyMaterial);
      body.castShadow = true;
      car.add(body);
      const roof = new THREE.Mesh(new THREE.BoxGeometry(2.35, 0.26, 8.74), darkMaterial);
      roof.position.y = 1.08;
      car.add(roof);
      const under = new THREE.Mesh(new THREE.BoxGeometry(2.15, 0.32, 8.2), darkMaterial);
      under.position.y = -1.1;
      car.add(under);
      const winLeft = new THREE.Mesh(new THREE.PlaneGeometry(7.8, 0.68), this.trainWindowMaterial);
      winLeft.position.set(1.381, 0.2, 0);
      winLeft.rotation.y = Math.PI / 2;
      car.add(winLeft);
      const winRight = new THREE.Mesh(new THREE.PlaneGeometry(7.8, 0.68), this.trainWindowMaterial);
      winRight.position.set(-1.381, 0.2, 0);
      winRight.rotation.y = -Math.PI / 2;
      car.add(winRight);
      const nose = new THREE.Mesh(new THREE.BoxGeometry(2.45, 0.5, 0.4), darkMaterial);
      nose.position.set(0, 0.3, 4.72);
      car.add(nose);
      const headlight = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.12, 0.08), headlightMaterial);
      headlight.position.set(0, -0.25, 4.73);
      car.add(headlight);
      const roofLight = new THREE.Mesh(
        new THREE.BoxGeometry(0.16, 0.05, 8.2),
        new THREE.MeshBasicMaterial({ color: 0x63e6ff, toneMapped: false }),
      );
      roofLight.position.y = 1.24;
      car.add(roofLight);
      this.group.add(car);
      this.trainCars.push(car);
    }
    this.trainT = 0.23;
  }

  private buildAirship(): void {
    this.airship = new THREE.Group();
    const hullMaterial = new THREE.MeshStandardMaterial({
      color: 0x46515a,
      roughness: 0.48,
      metalness: 0.34,
    });
    const hull = new THREE.Mesh(new THREE.SphereGeometry(1, 40, 20), hullMaterial);
    hull.scale.set(6.6, 6.2, 18);
    hull.castShadow = true;
    this.airship.add(hull);

    const gondola = new THREE.Mesh(
      new THREE.BoxGeometry(3.6, 1.45, 7.2),
      new THREE.MeshStandardMaterial({ color: 0x171e23, roughness: 0.4, metalness: 0.5 }),
    );
    gondola.position.y = -6.1;
    this.airship.add(gondola);

    const tailFin = new THREE.Mesh(
      new THREE.BoxGeometry(12.8, 0.22, 3.8),
      hullMaterial,
    );
    tailFin.position.set(0, 0.4, -15.8);
    this.airship.add(tailFin);
    const verticalFin = new THREE.Mesh(
      new THREE.BoxGeometry(0.22, 6.6, 3.8),
      hullMaterial,
    );
    verticalFin.position.set(0, 3.2, -15.8);
    this.airship.add(verticalFin);

    const airshipSignTexture = makeSignTexture({
      title: 'DEEPSEEK',
      subtitle: 'HYPERCITY // SIGNAL CARRIER',
      accent: '#78ecff',
      width: 1024,
      height: 320,
      align: 'center',
    });
    const signMaterial = new THREE.MeshBasicMaterial({
      map: airshipSignTexture,
      toneMapped: true,
    });
    signMaterial.color.setRGB(1.15, 1.15, 1.15);
    for (const side of [-1, 1]) {
      const panel = new THREE.Mesh(new THREE.PlaneGeometry(14.5, 4.3), signMaterial);
      panel.position.set(side * 6.4, -1.1, 0.3);
      panel.rotation.y = side * Math.PI / 2;
      this.airship.add(panel);
    }

    const beaconMaterial = new THREE.MeshBasicMaterial({ color: 0xff5d6c, toneMapped: false });
    for (const z of [-18, 18]) {
      const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.22, 6, 4), beaconMaterial);
      beacon.position.set(0, z > 0 ? 1.6 : 5.1, z);
      this.airship.add(beacon);
    }
    const glow = new THREE.PointLight(0x7cecff, 45, 35, 2);
    glow.position.set(0, -4, 2);
    this.airship.add(glow);
    this.airship.position.set(230, 118, 0);
    this.group.add(this.airship);
  }

  private buildDrones(): void {
    const rng = mulberry32(this.plan.seed ^ 0xd20e5);
    const count = 20;
    this.droneStates = [];
    this.dronePositions = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      this.droneStates.push({
        radius: range(rng, 38, 160),
        height: range(rng, 28, 92),
        speed: range(rng, 0.055, 0.17) * (rng() > 0.5 ? 1 : -1),
        phase: rng() * Math.PI * 2,
        tilt: range(rng, 0.15, 0.8),
      });
    }
    const geometry = new THREE.BoxGeometry(1.0, 0.24, 1.0);
    const material = new THREE.MeshStandardMaterial({
      color: 0x313a40,
      roughness: 0.38,
      metalness: 0.68,
    });
    this.droneBody = new THREE.InstancedMesh(geometry, material, count);
    this.droneBody.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.droneBody.frustumCulled = false;
    this.group.add(this.droneBody);

    this.droneGlowMaterial = new THREE.PointsMaterial({
      color: 0x80f1ff,
      map: makeGlowTexture(64),
      size: 2.0,
      transparent: true,
      opacity: 0.8,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      sizeAttenuation: true,
      toneMapped: false,
    });
    this.dronePositionsAttribute = new THREE.BufferAttribute(this.dronePositions, 3);
    this.dronePositionsAttribute.setUsage(THREE.DynamicDrawUsage);
    this.dronePoints = new THREE.Points(
      new THREE.BufferGeometry().setAttribute('position', this.dronePositionsAttribute),
      this.droneGlowMaterial,
    );
    this.dronePoints.frustumCulled = false;
    this.group.add(this.dronePoints);
  }

  update(elapsed: number, dt: number, lightsOn: number, wetness: number): void {
    this.elapsed = elapsed;
    const clampedDt = Math.min(dt, 0.06);
    const night = THREE.MathUtils.clamp(lightsOn, 0, 1);

    this.windowUniforms.uTime.value = elapsed;
    this.windowUniforms.uNight.value = night;
    this.windowUniforms.uPulseStart.value = this.pulseStart;
    this.windowUniforms.uPulseOrigin.value.copy(this.pulseOrigin);

    if (this.lampHeadMaterial) this.lampHeadMaterial.opacity = 0.06 + night * 0.8;
    if (this.lampGlowMaterial) this.lampGlowMaterial.opacity = 0.04 + night * 0.64;
    if (this.lampPoolMaterial) this.lampPoolMaterial.opacity = 0.006 + night * 0.3;
    if (this.neonMaterial) this.neonMaterial.opacity = 0.1 + night * 0.75;
    if (this.beaconMaterial) {
      this.beaconMaterial.opacity = 0.28 + 0.35 * night + Math.sin(elapsed * 3.4) * 0.1 * night;
    }
    if (this.trainWindowMaterial) this.trainWindowMaterial.opacity = 0.15 + night * 0.85;
    if (this.droneGlowMaterial) this.droneGlowMaterial.opacity = 0.25 + night * 0.75;
    if (this.storefrontMaterial) this.storefrontMaterial.opacity = 0.01 + night * 0.42;
    if (this.storefrontWindowMaterial) this.storefrontWindowMaterial.opacity = 0.04 + night * 0.55;
    if (this.landmarkRibbonMaterial) this.landmarkRibbonMaterial.opacity = 0.08 + night * 0.62;
    if (this.roadGlowMaterial) this.roadGlowMaterial.opacity = 0.015 + night * 0.28;

    this.asphaltMaterial.roughness = THREE.MathUtils.lerp(0.9, 0.32, wetness);
    this.asphaltMaterial.metalness = THREE.MathUtils.lerp(0.06, 0.28, wetness);
    this.asphaltMaterial.envMapIntensity = THREE.MathUtils.lerp(0.7, 1.85, wetness);
    this.sidewalkMaterial.roughness = THREE.MathUtils.lerp(0.92, 0.58, wetness * 0.8);

    this.coreRingGroup.rotation.y += clampedDt * 0.16;
    this.coreRingGroup.rotation.x = Math.sin(elapsed * 0.22) * 0.1;
    this.coreOrb.rotation.y += clampedDt * 0.36;
    this.coreOrb.rotation.x = Math.sin(elapsed * 0.28) * 0.12;

    const pulseAge = elapsed - this.pulseStart;
    const pulseEnergy = pulseAge >= 0 && pulseAge < 4 ? Math.exp(-pulseAge * 1.4) : 0;
    this.coreOrb.scale.setScalar(1 + pulseEnergy * 0.09);
    this.coreLight.intensity = 220 + night * 260 + pulseEnergy * 620;

    this.pulseRings.forEach((ring, index) => {
      const age = pulseAge - index * 0.2;
      const active = age > 0 && age < 3.1;
      ring.visible = active;
      if (!active) return;
      const scale = 1 + age * 7.5;
      ring.scale.setScalar(scale);
      ring.material.opacity = Math.max(0, (1 - age / 3.1) ** 2) * 0.75;
    });

    if (this.trainCars.length) {
      this.trainT = (this.trainT + (clampedDt * 10.5) / this.trainLength) % 1;
      for (let i = 0; i < this.trainCars.length; i++) {
        const car = this.trainCars[i]!;
        const t = (this.trainT - (i * 10.4) / this.trainLength + 1) % 1;
        const point = this.trainCurve.getPointAt(t);
        const tangent = this.trainCurve.getTangentAt(t);
        car.position.set(point.x, point.y + 1.56, point.z);
        car.rotation.set(0, Math.atan2(tangent.x, tangent.z), 0);
      }
    }

    this.airshipAngle += clampedDt * 0.0075;
    const airshipRadius = 265;
    const ax = Math.cos(this.airshipAngle) * airshipRadius;
    const az = Math.sin(this.airshipAngle) * airshipRadius;
    this.airship.position.set(ax, 115 + Math.sin(this.airshipAngle * 1.7) * 5, az);
    this.airship.rotation.y = -this.airshipAngle;
    this.airship.rotation.z = Math.sin(elapsed * 0.2) * 0.02;

    this.updateDrones(elapsed, night);

    if (this.selectionMaterial) {
      this.selectionMaterial.opacity = 0.62 + Math.sin(elapsed * 3) * 0.18;
    }
  }

  private updateDrones(elapsed: number, lightsOn: number): void {
    const count = this.droneStates.length;
    for (let i = 0; i < count; i++) {
      const state = this.droneStates[i]!;
      const angle = state.phase + elapsed * state.speed;
      const bob = Math.sin(elapsed * 0.8 + state.phase) * 2.2;
      const x = Math.cos(angle) * state.radius;
      const z = Math.sin(angle) * state.radius;
      const y = state.height + bob;
      dummy.position.set(x, y, z);
      dummy.rotation.set(Math.sin(elapsed * 0.4 + state.phase) * 0.12, -angle + Math.PI / 2, Math.sin(elapsed * 0.5 + state.phase) * state.tilt);
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      this.droneBody.setMatrixAt(i, dummy.matrix);
      this.dronePositions[i * 3] = x;
      this.dronePositions[i * 3 + 1] = y - 0.35;
      this.dronePositions[i * 3 + 2] = z;
    }
    this.droneBody.instanceMatrix.needsUpdate = true;
    this.dronePositionsAttribute.needsUpdate = true;
    this.droneGlowMaterial.opacity = 0.12 + lightsOn * 0.82;
  }

  triggerPulse(origin?: { x: number; z: number }): void {
    this.pulseStart = this.elapsed;
    const x = origin?.x ?? this.plan.core.x;
    const z = origin?.z ?? this.plan.core.z;
    this.pulseOrigin.set(x, z);
    this.windowUniforms.uPulseStart.value = this.pulseStart;
    this.windowUniforms.uPulseOrigin.value.copy(this.pulseOrigin);
    for (const ring of this.pulseRings) {
      ring.position.set(x, 0.54, z);
      ring.scale.setScalar(1);
      ring.visible = true;
    }
  }

  setFog(color: THREE.Color, density: number): void {
    this.windowUniforms.uFogColor.value.copy(color);
    this.windowUniforms.uFogDensity.value = density;
  }

  pick(raycaster: THREE.Raycaster): PickResult | null {
    const objects: THREE.Object3D[] = [...this.buildingMeshes, this.coreOrb];
    const hits = raycaster.intersectObjects(objects, false);
    if (!hits.length) return null;
    const hit = hits[0]!;
    if (hit.object === this.coreOrb) return { type: 'core' };
    const mesh = hit.object as THREE.InstancedMesh;
    const ids = this.buildingIdsByMesh.get(mesh);
    if (!ids || hit.instanceId === undefined) return null;
    const building = this.getBuilding(ids[hit.instanceId]);
    if (!building) return null;
    return { type: 'building', building };
  }

  selectBuilding(id: string | null): BuildingPlan | null {
    const building = this.getBuilding(id);
    this.selectedBuildingId = building?.id ?? null;
    if (!building) {
      if (this.selectionHelper) this.selectionHelper.visible = false;
      return null;
    }
    if (!this.selectionHelper) {
      this.selectionBox.makeEmpty();
      this.selectionHelper = new THREE.Box3Helper(this.selectionBox, 0x6ceaff);
      this.selectionHelper.renderOrder = 80;
      this.selectionMaterial = this.selectionHelper.material as THREE.LineBasicMaterial;
      this.selectionMaterial.transparent = true;
      this.selectionMaterial.opacity = 0.8;
      this.selectionMaterial.depthTest = false;
      this.selectionMaterial.toneMapped = false;
      this.selectionHelper.visible = false;
      this.group.add(this.selectionHelper);
    }
    this.selectionBox.makeEmpty();
    for (const volume of building.volumes) {
      this.selectionBox.expandByPoint(new THREE.Vector3(volume.x - volume.w / 2, volume.y - 0.1, volume.z - volume.d / 2));
      this.selectionBox.expandByPoint(new THREE.Vector3(volume.x + volume.w / 2, volume.y + volume.h + 0.1, volume.z + volume.d / 2));
    }
    this.selectionHelper.box.copy(this.selectionBox);
    this.selectionHelper.visible = true;
    this.selectionHelper.updateMatrixWorld(true);
    return building;
  }
}
