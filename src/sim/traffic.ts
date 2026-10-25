import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import type { CityPlan } from '../types';
import { clamp, mulberry32, pick, range, shortestAngle, smoothstep } from '../utils/random';
import { makeGlowTexture, makeRadialFloorTexture } from '../utils/textures';

const LANE_OFFSET = 3.15;
const CAR_POOL = 260;
const ACTIVE_NORMAL = 180;
const ACTIVE_RUSH = 240;
const SIGNAL_CYCLE = 26;

type SignalState = 'green' | 'amber' | 'red';

interface CarState {
  fromIx: number;
  fromIz: number;
  toIx: number;
  toIz: number;
  dirX: number;
  dirZ: number;
  progress: number;
  edgeLength: number;
  prevOffsetX: number;
  prevOffsetZ: number;
  x: number;
  z: number;
  speed: number;
  baseSpeed: number;
  scale: number;
  yaw: number;
  color: number;
}

const CAR_COLORS = [
  0xe7e8e4,
  0x1b2025,
  0x8a969d,
  0xb83633,
  0x345f87,
  0xd2ad52,
  0x2d4c42,
  0x6f7479,
  0xbf6d3d,
  0x30363c,
];

export class TrafficSystem {
  readonly group = new THREE.Group();
  readonly cars: CarState[] = [];

  private readonly plan: CityPlan;
  private readonly rng = mulberry32(0xca75);
  private readonly bodyMesh: THREE.InstancedMesh;
  private readonly cabinMesh: THREE.InstancedMesh;
  private readonly underbodyMesh: THREE.InstancedMesh;
  private readonly headlightMesh: THREE.InstancedMesh;
  private readonly taillightMesh: THREE.InstancedMesh;
  private readonly lightPoolMesh: THREE.InstancedMesh;
  private readonly headlightMaterial: THREE.MeshBasicMaterial;
  private readonly taillightMaterial: THREE.MeshBasicMaterial;
  private readonly lightPoolMaterial: THREE.MeshBasicMaterial;
  private readonly headlightGlowMaterial: THREE.PointsMaterial;
  private readonly taillightGlowMaterial: THREE.PointsMaterial;
  private readonly headlightGlowPoints: THREE.Points;
  private readonly taillightGlowPoints: THREE.Points;
  private readonly headlightGlowPositions = new Float32Array(CAR_POOL * 2 * 3);
  private readonly taillightGlowPositions = new Float32Array(CAR_POOL * 2 * 3);
  private readonly headlightGlowAttribute: THREE.BufferAttribute;
  private readonly taillightGlowAttribute: THREE.BufferAttribute;
  private signalLightMesh!: THREE.InstancedMesh;
  private readonly signalColors: THREE.InstancedBufferAttribute | null;
  private activeCount = ACTIVE_NORMAL;
  private profile: 'normal' | 'rush' = 'normal';
  private signalTimer = 0;
  private elapsed = 0;

  constructor(plan: CityPlan) {
    this.plan = plan;
    this.group.name = 'traffic';

    for (let i = 0; i < CAR_POOL; i++) {
      const car = this.makeCar();
      this.spawnCar(car, true);
      this.computeCarTransform(car);
      this.cars.push(car);
    }

    const bodyGeometry = new RoundedBoxGeometry(1.92, 0.62, 4.15, 2, 0.15);
    bodyGeometry.translate(0, 0.68, 0);
    const bodyMaterial = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.32,
      metalness: 0.68,
      envMapIntensity: 1.35,
    });
    this.bodyMesh = new THREE.InstancedMesh(bodyGeometry, bodyMaterial, CAR_POOL);
    this.bodyMesh.castShadow = true;
    this.bodyMesh.frustumCulled = false;
    this.bodyMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.cars.forEach((car, index) => {
      this.bodyMesh.setColorAt(index, tempColor.setHex(car.color));
    });
    if (this.bodyMesh.instanceColor) this.bodyMesh.instanceColor.needsUpdate = true;
    this.group.add(this.bodyMesh);

    const cabinGeometry = new RoundedBoxGeometry(1.62, 0.5, 2.18, 2, 0.14);
    cabinGeometry.translate(0, 1.16, -0.16);
    const cabinMaterial = new THREE.MeshStandardMaterial({
      color: 0x111b23,
      roughness: 0.12,
      metalness: 0.55,
      envMapIntensity: 1.5,
    });
    this.cabinMesh = new THREE.InstancedMesh(cabinGeometry, cabinMaterial, CAR_POOL);
    this.cabinMesh.castShadow = true;
    this.cabinMesh.frustumCulled = false;
    this.cabinMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.group.add(this.cabinMesh);

    const underbodyGeometry = new THREE.BoxGeometry(1.68, 0.35, 3.75);
    underbodyGeometry.translate(0, 0.32, 0);
    const underbodyMaterial = new THREE.MeshStandardMaterial({
      color: 0x0a0d10,
      roughness: 0.72,
      metalness: 0.4,
    });
    this.underbodyMesh = new THREE.InstancedMesh(underbodyGeometry, underbodyMaterial, CAR_POOL);
    this.underbodyMesh.frustumCulled = false;
    this.underbodyMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.group.add(this.underbodyMesh);

    const headlightGeometry = new THREE.BoxGeometry(0.46, 0.16, 0.06);
    const headlightPart = headlightGeometry.clone().translate(-0.62, 0.72, 2.075);
    const headlightPart2 = headlightGeometry.clone().translate(0.62, 0.72, 2.075);
    const joinedHeadlights = new THREE.BufferGeometry();
    const merged = mergeSimpleBufferGeometry(headlightPart, headlightPart2);
    this.headlightMaterial = new THREE.MeshBasicMaterial({
      color: new THREE.Color(0xffe9c0).multiplyScalar(2.4),
      toneMapped: false,
      transparent: true,
      opacity: 0.8,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.headlightMesh = new THREE.InstancedMesh(merged, this.headlightMaterial, CAR_POOL);
    this.headlightMesh.frustumCulled = false;
    this.headlightMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.group.add(this.headlightMesh);
    joinedHeadlights.dispose();

    const taillightPart = new THREE.BoxGeometry(0.48, 0.12, 0.05).translate(-0.61, 0.72, -2.075);
    const taillightPart2 = new THREE.BoxGeometry(0.48, 0.12, 0.05).translate(0.61, 0.72, -2.075);
    const mergedTaillights = mergeSimpleBufferGeometry(taillightPart, taillightPart2);
    this.taillightMaterial = new THREE.MeshBasicMaterial({
      color: new THREE.Color(0xff2537).multiplyScalar(2.1),
      toneMapped: false,
      transparent: true,
      opacity: 0.8,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.taillightMesh = new THREE.InstancedMesh(mergedTaillights, this.taillightMaterial, CAR_POOL);
    this.taillightMesh.frustumCulled = false;
    this.taillightMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.group.add(this.taillightMesh);

    const poolGeometry = new THREE.PlaneGeometry(5.1, 10.5);
    poolGeometry.rotateX(-Math.PI / 2);
    poolGeometry.translate(0, 0.075, 5.25);
    this.lightPoolMaterial = new THREE.MeshBasicMaterial({
      color: new THREE.Color(0xffd6a0).multiplyScalar(0.9),
      map: makeRadialFloorTexture(128),
      transparent: true,
      opacity: 0.25,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    });
    this.lightPoolMesh = new THREE.InstancedMesh(poolGeometry, this.lightPoolMaterial, CAR_POOL);
    this.lightPoolMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.lightPoolMesh.frustumCulled = false;
    this.group.add(this.lightPoolMesh);

    this.headlightGlowMaterial = new THREE.PointsMaterial({
      color: new THREE.Color(0xffeccb).multiplyScalar(2),
      map: makeGlowTexture(64),
      size: 1.8,
      transparent: true,
      opacity: 0.7,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      sizeAttenuation: true,
      toneMapped: false,
      fog: true,
    });
    this.taillightGlowMaterial = new THREE.PointsMaterial({
      color: new THREE.Color(0xff2c41).multiplyScalar(1.8),
      map: makeGlowTexture(64),
      size: 1.5,
      transparent: true,
      opacity: 0.7,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      sizeAttenuation: true,
      toneMapped: false,
      fog: true,
    });
    const headlightPointsGeometry = new THREE.BufferGeometry();
    this.headlightGlowAttribute = new THREE.BufferAttribute(this.headlightGlowPositions, 3);
    this.headlightGlowAttribute.setUsage(THREE.DynamicDrawUsage);
    headlightPointsGeometry.setAttribute('position', this.headlightGlowAttribute);
    headlightPointsGeometry.setDrawRange(0, 0);
    this.headlightGlowPoints = new THREE.Points(headlightPointsGeometry, this.headlightGlowMaterial);
    this.headlightGlowPoints.frustumCulled = false;
    this.group.add(this.headlightGlowPoints);
    const taillightGeometry = new THREE.BufferGeometry();
    this.taillightGlowAttribute = new THREE.BufferAttribute(this.taillightGlowPositions, 3);
    this.taillightGlowAttribute.setUsage(THREE.DynamicDrawUsage);
    taillightGeometry.setAttribute('position', this.taillightGlowAttribute);
    taillightGeometry.setDrawRange(0, 0);
    this.taillightGlowPoints = new THREE.Points(taillightGeometry, this.taillightGlowMaterial);
    this.taillightGlowPoints.frustumCulled = false;
    this.group.add(this.taillightGlowPoints);

    this.buildParkedCars(bodyGeometry, bodyMaterial, cabinGeometry, cabinMaterial, underbodyGeometry, underbodyMaterial);
    this.buildSignals();
    this.signalColors = this.signalLightMesh.instanceColor;
    this.setMeshCounts(this.activeCount);
    this.updateInstanceMatrices();
  }

  setProfile(profile: 'normal' | 'rush'): void {
    if (profile === this.profile) return;
    const previous = this.activeCount;
    this.profile = profile;
    this.activeCount = profile === 'rush' ? ACTIVE_RUSH : ACTIVE_NORMAL;
    if (this.activeCount > previous) {
      for (let i = previous; i < this.activeCount; i++) {
        const car = this.cars[i];
        if (!car) continue;
        this.spawnCar(car, true);
        this.computeCarTransform(car);
        this.bodyMesh.setColorAt(i, tempColor.setHex(car.color));
      }
      if (this.bodyMesh.instanceColor) this.bodyMesh.instanceColor.needsUpdate = true;
    }
    this.setMeshCounts(this.activeCount);
  }

  get activeVehicles(): number {
    return this.activeCount;
  }

  update(dt: number, elapsed: number, lightsOn: number, wetness: number): void {
    const clampedDt = Math.min(dt, 0.06);
    this.elapsed = elapsed;
    const speedFactor = this.profile === 'rush' ? 1.18 : 1;
    const night = clamp(lightsOn, 0, 1);

    this.headlightMaterial.opacity = 0.18 + night * 0.82;
    this.taillightMaterial.opacity = 0.25 + night * 0.75;
    this.lightPoolMaterial.opacity = clamp(wetness * 0.17 + night * 0.32, 0, 0.48);
    this.headlightGlowMaterial.opacity = 0.18 + night * 0.74;
    this.taillightGlowMaterial.opacity = 0.22 + night * 0.7;

    for (let i = 0; i < this.activeCount; i++) {
      const car = this.cars[i]!;
      this.updateCar(car, clampedDt, elapsed, speedFactor, i);
    }
    this.updateInstanceMatrices();

    this.signalTimer -= clampedDt;
    if (this.signalTimer <= 0) {
      this.signalTimer = 0.22;
      this.updateSignalVisuals();
    }
  }

  private makeCar(): CarState {
    return {
      fromIx: 0,
      fromIz: 0,
      toIx: 0,
      toIz: 0,
      dirX: 1,
      dirZ: 0,
      progress: 0,
      edgeLength: 56,
      prevOffsetX: 0,
      prevOffsetZ: 0,
      x: 0,
      z: 0,
      speed: 0,
      baseSpeed: 12,
      scale: 1,
      yaw: 0,
      color: pick(this.rng, CAR_COLORS),
    };
  }

  private spawnCar(car: CarState, randomProgress: boolean): void {
    const lines = this.plan.roadLines.length;
    const horizontal = this.rng() < 0.5;
    const line = Math.floor(this.rng() * lines);
    const segment = Math.floor(this.rng() * (lines - 1));
    const positive = this.rng() < 0.5;
    if (horizontal) {
      car.fromIx = positive ? segment : segment + 1;
      car.toIx = positive ? segment + 1 : segment;
      car.fromIz = line;
      car.toIz = line;
    } else {
      car.fromIz = positive ? segment : segment + 1;
      car.toIz = positive ? segment + 1 : segment;
      car.fromIx = line;
      car.toIx = line;
    }
    const from = this.roadPoint(car.fromIx, car.fromIz);
    const to = this.roadPoint(car.toIx, car.toIz);
    car.dirX = Math.sign(to.x - from.x);
    car.dirZ = Math.sign(to.z - from.z);
    car.edgeLength = Math.hypot(to.x - from.x, to.z - from.z);
    car.progress = randomProgress ? range(this.rng, 2, car.edgeLength - 12) : 0;
    car.speed = range(this.rng, 6, 12);
    car.baseSpeed = range(this.rng, 9.5, 15.5);
    car.scale = range(this.rng, 0.88, 1.14);
    car.yaw = Math.atan2(car.dirX, car.dirZ);
    const prev = this.laneOffset(car);
    car.prevOffsetX = prev.x;
    car.prevOffsetZ = prev.z;
    car.color = pick(this.rng, CAR_COLORS);
  }

  private roadPoint(ix: number, iz: number): { x: number; z: number } {
    return {
      x: this.plan.roadLines[ix]!,
      z: this.plan.roadLines[iz]!,
    };
  }

  private laneOffset(car: CarState): { x: number; z: number } {
    return {
      x: -car.dirZ * LANE_OFFSET,
      z: car.dirX * LANE_OFFSET,
    };
  }

  private computeCarTransform(car: CarState): void {
    const from = this.roadPoint(car.fromIx, car.fromIz);
    const right = this.laneOffset(car);
    const blend = smoothstep(0, 1, Math.min(1, car.progress / 7.5));
    const offsetX = car.prevOffsetX + (right.x - car.prevOffsetX) * blend;
    const offsetZ = car.prevOffsetZ + (right.z - car.prevOffsetZ) * blend;
    car.x = from.x + car.dirX * car.progress + offsetX;
    car.z = from.z + car.dirZ * car.progress + offsetZ;
  }

  private updateCar(car: CarState, dt: number, elapsed: number, speedFactor: number, carIndex: number): void {
    const axisHorizontal = car.dirX !== 0;
    const signal = this.getSignal(car.toIx, car.toIz, axisHorizontal, elapsed);
    const stopProgress = car.edgeLength - 11.3;
    const distanceToStop = stopProgress - car.progress;
    let targetSpeed = car.baseSpeed * speedFactor;

    if (signal === 'red' && distanceToStop > -0.1 && distanceToStop < 34) {
      targetSpeed = Math.min(targetSpeed, Math.sqrt(2 * 5.5 * Math.max(0, distanceToStop - 1.6)));
    } else if (signal === 'amber' && distanceToStop > 8 && distanceToStop < 32) {
      targetSpeed = Math.min(targetSpeed, Math.sqrt(2 * 5.5 * Math.max(0, distanceToStop - 1.6)));
    }

    // A lightweight car-following query is enough at this scale and keeps queues legible.
    let nearestGap = Infinity;
    for (let j = 0; j < this.activeCount; j++) {
      if (j === carIndex) continue;
      const other = this.cars[j]!;
      const dx = other.x - car.x;
      const dz = other.z - car.z;
      const ahead = dx * car.dirX + dz * car.dirZ;
      if (ahead <= 0 || ahead > 16) continue;
      const lateral = Math.abs(dx * -car.dirZ + dz * car.dirX);
      if (lateral > 2.5) continue;
      const alignment = other.dirX * car.dirX + other.dirZ * car.dirZ;
      if (alignment < 0.2) continue;
      nearestGap = Math.min(nearestGap, ahead);
    }
    if (nearestGap < Infinity) {
      targetSpeed = Math.min(targetSpeed, Math.max(0, (nearestGap - 5.1) * 1.45));
    }

    const acceleration = targetSpeed > car.speed ? 2.2 : 5.2;
    car.speed += clamp(targetSpeed - car.speed, -acceleration * dt * 2.2, acceleration * dt * 2.2);
    car.speed = Math.max(0, car.speed);

    let nextProgress = car.progress + car.speed * dt;
    if (
      (signal === 'red' || (signal === 'amber' && distanceToStop > 8)) &&
      nextProgress > stopProgress &&
      car.progress <= stopProgress + 0.2
    ) {
      nextProgress = Math.max(car.progress, stopProgress);
      if (car.progress < stopProgress - 0.05) car.speed = Math.min(car.speed, 1.4);
      else car.speed = 0;
    }
    car.progress = nextProgress;
    const desiredYaw = Math.atan2(car.dirX, car.dirZ);
    car.yaw += shortestAngle(car.yaw, desiredYaw) * Math.min(1, dt * 7);

    if (car.progress >= car.edgeLength) {
      let carried = car.progress - car.edgeLength;
      const previousOffset = this.laneOffset(car);
      car.prevOffsetX = previousOffset.x;
      car.prevOffsetZ = previousOffset.z;
      car.fromIx = car.toIx;
      car.fromIz = car.toIz;
      const next = this.pickNextNode(car);
      car.toIx = next.ix;
      car.toIz = next.iz;
      const from = this.roadPoint(car.fromIx, car.fromIz);
      const to = this.roadPoint(car.toIx, car.toIz);
      car.dirX = Math.sign(to.x - from.x);
      car.dirZ = Math.sign(to.z - from.z);
      car.edgeLength = Math.hypot(to.x - from.x, to.z - from.z);
      carried = Math.min(car.edgeLength * 0.9, carried);
      car.progress = carried;
      car.speed *= 0.9;
    }

    this.computeCarTransform(car);
  }

  private pickNextNode(car: CarState): { ix: number; iz: number } {
    const directions = [
      { dx: car.dirX, dz: car.dirZ, weight: 3 },
      { dx: -car.dirZ, dz: car.dirX, weight: 1.2 },
      { dx: car.dirZ, dz: -car.dirX, weight: 1.2 },
      { dx: -car.dirX, dz: -car.dirZ, weight: 0 },
    ];
    const choices: { ix: number; iz: number; weight: number }[] = [];
    const lineMax = this.plan.roadLines.length - 1;
    for (const direction of directions) {
      if (direction.weight <= 0) continue;
      const ix = car.toIx + direction.dx;
      const iz = car.toIz + direction.dz;
      if (ix < 0 || iz < 0 || ix > lineMax || iz > lineMax) continue;
      choices.push({ ix, iz, weight: direction.weight });
    }
    if (!choices.length) {
      return { ix: clamp(car.toIx + 1, 0, lineMax), iz: car.toIz };
    }
    let total = 0;
    for (const choice of choices) total += choice.weight;
    let roll = this.rng() * total;
    for (const choice of choices) {
      roll -= choice.weight;
      if (roll <= 0) return { ix: choice.ix, iz: choice.iz };
    }
    return { ix: choices[0]!.ix, iz: choices[0]!.iz };
  }

  private getSignal(ix: number, iz: number, horizontal: boolean, time: number): SignalState {
    const offset = ix * 1.15 + iz * 0.65;
    const phase = (time + offset) % SIGNAL_CYCLE;
    if (horizontal) {
      if (phase < 10) return 'green';
      if (phase < 12) return 'amber';
      return 'red';
    }
    if (phase >= 13 && phase < 23) return 'green';
    if (phase >= 23 && phase < 25) return 'amber';
    return 'red';
  }

  private setMeshCounts(count: number): void {
    this.bodyMesh.count = count;
    this.cabinMesh.count = count;
    this.underbodyMesh.count = count;
    this.headlightMesh.count = count;
    this.taillightMesh.count = count;
    this.lightPoolMesh.count = count;
  }

  updateInstanceMatrices(): void {
    for (let i = 0; i < this.activeCount; i++) {
      const car = this.cars[i]!;
      dummy.position.set(car.x, 0.08, car.z);
      dummy.rotation.set(0, car.yaw, 0);
      dummy.scale.set(car.scale, car.scale, car.scale);
      dummy.updateMatrix();
      const matrix = dummy.matrix;
      this.bodyMesh.setMatrixAt(i, matrix);
      this.cabinMesh.setMatrixAt(i, matrix);
      this.underbodyMesh.setMatrixAt(i, matrix);
      this.headlightMesh.setMatrixAt(i, matrix);
      this.taillightMesh.setMatrixAt(i, matrix);
      this.lightPoolMesh.setMatrixAt(i, matrix);

      const sin = Math.sin(car.yaw);
      const cos = Math.cos(car.yaw);
      const rightX = cos;
      const rightZ = -sin;
      const frontX = sin * 2.08 * car.scale;
      const frontZ = cos * 2.08 * car.scale;
      const rearX = -sin * 2.08 * car.scale;
      const rearZ = -cos * 2.08 * car.scale;
      const side = 0.58 * car.scale;
      const head = i * 6;
      this.headlightGlowPositions[head] = car.x + frontX + rightX * side;
      this.headlightGlowPositions[head + 1] = 0.74;
      this.headlightGlowPositions[head + 2] = car.z + frontZ + rightZ * side;
      this.headlightGlowPositions[head + 3] = car.x + frontX - rightX * side;
      this.headlightGlowPositions[head + 4] = 0.74;
      this.headlightGlowPositions[head + 5] = car.z + frontZ - rightZ * side;
      this.taillightGlowPositions[head] = car.x + rearX + rightX * side;
      this.taillightGlowPositions[head + 1] = 0.72;
      this.taillightGlowPositions[head + 2] = car.z + rearZ + rightZ * side;
      this.taillightGlowPositions[head + 3] = car.x + rearX - rightX * side;
      this.taillightGlowPositions[head + 4] = 0.72;
      this.taillightGlowPositions[head + 5] = car.z + rearZ - rightZ * side;
    }
    this.headlightGlowAttribute.needsUpdate = true;
    this.taillightGlowAttribute.needsUpdate = true;
    const headlightGeometry = this.headlightGlowPoints.geometry;
    const taillightGeometry = this.taillightGlowPoints.geometry;
    headlightGeometry.setDrawRange(0, this.activeCount * 2);
    taillightGeometry.setDrawRange(0, this.activeCount * 2);
    this.bodyMesh.instanceMatrix.needsUpdate = true;
    this.cabinMesh.instanceMatrix.needsUpdate = true;
    this.underbodyMesh.instanceMatrix.needsUpdate = true;
    this.headlightMesh.instanceMatrix.needsUpdate = true;
    this.taillightMesh.instanceMatrix.needsUpdate = true;
    this.lightPoolMesh.instanceMatrix.needsUpdate = true;
  }

  private buildParkedCars(
    bodyGeometry: THREE.BufferGeometry,
    bodyMaterial: THREE.Material,
    cabinGeometry: THREE.BufferGeometry,
    cabinMaterial: THREE.Material,
    underbodyGeometry: THREE.BufferGeometry,
    underbodyMaterial: THREE.Material,
  ): void {
    const count = 44;
    const rng = mulberry32(this.plan.seed ^ 0x5041524b);
    const centers: number[] = [];
    for (let i = 0; i < this.plan.blocksAcross; i++) {
      centers.push((i - (this.plan.blocksAcross - 1) / 2) * this.plan.pitch);
    }
    const body = new THREE.InstancedMesh(bodyGeometry, bodyMaterial, count);
    const cabin = new THREE.InstancedMesh(cabinGeometry, cabinMaterial, count);
    const under = new THREE.InstancedMesh(underbodyGeometry, underbodyMaterial, count);
    body.frustumCulled = false;
    cabin.frustumCulled = false;
    under.frustumCulled = false;
    body.castShadow = true;
    cabin.castShadow = true;
    const lineMin = 3;
    const lineMax = this.plan.roadLines.length - 3;
    for (let i = 0; i < count; i++) {
      const vertical = rng() < 0.55;
      const lineIndex = Math.floor(range(rng, lineMin, lineMax + 1));
      const line = this.plan.roadLines[lineIndex]!;
      const blockCenter = centers[Math.floor(rng() * centers.length)]!;
      const side = rng() < 0.5 ? -1 : 1;
      const curbOffset = side * (this.plan.roadWidth / 2 - 1.6);
      const alongOffset = range(rng, -9, 9);
      const scale = range(rng, 0.9, 1.08);
      if (vertical) {
        dummy.position.set(line + curbOffset, 0.08, blockCenter + alongOffset);
        dummy.rotation.set(0, rng() < 0.5 ? 0 : Math.PI, 0);
      } else {
        dummy.position.set(blockCenter + alongOffset, 0.08, line + curbOffset);
        dummy.rotation.set(0, rng() < 0.5 ? Math.PI / 2 : -Math.PI / 2, 0);
      }
      dummy.scale.set(scale, scale, scale);
      dummy.updateMatrix();
      body.setMatrixAt(i, dummy.matrix);
      cabin.setMatrixAt(i, dummy.matrix);
      under.setMatrixAt(i, dummy.matrix);
      body.setColorAt(i, tempColor.setHex(pick(rng, CAR_COLORS)));
    }
    body.instanceMatrix.needsUpdate = true;
    cabin.instanceMatrix.needsUpdate = true;
    under.instanceMatrix.needsUpdate = true;
    if (body.instanceColor) body.instanceColor.needsUpdate = true;
    this.group.add(body, cabin, under);
  }

  private buildSignals(): void {
    const lines = this.plan.roadLines.length;
    const nodeCount = lines * lines;
    const poleGeometry = new THREE.BoxGeometry(0.13, 4.45, 0.13);
    poleGeometry.translate(0, 2.225, 0);
    const housingGeometry = new THREE.BoxGeometry(0.52, 1.18, 0.32);
    housingGeometry.translate(0, 4.15, 0);
    const darkMetal = new THREE.MeshStandardMaterial({
      color: 0x242c31,
      roughness: 0.4,
      metalness: 0.66,
    });
    this.group.add(
      new THREE.InstancedMesh(poleGeometry, darkMetal, nodeCount),
      new THREE.InstancedMesh(housingGeometry, darkMetal, nodeCount),
    );
    const poles = this.group.children[this.group.children.length - 2] as THREE.InstancedMesh;
    const housings = this.group.children[this.group.children.length - 1] as THREE.InstancedMesh;
    const lampGeometry = new THREE.SphereGeometry(0.115, 8, 6);
    const lampMaterial = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      toneMapped: false,
    });
    this.signalLightMesh = new THREE.InstancedMesh(lampGeometry, lampMaterial, nodeCount * 2);
    this.signalLightMesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    this.group.add(this.signalLightMesh);

    let lampIndex = 0;
    for (let iz = 0; iz < lines; iz++) {
      for (let ix = 0; ix < lines; ix++) {
        const nodeIndex = iz * lines + ix;
        const x = this.plan.roadLines[ix]! + 8.7;
        const z = this.plan.roadLines[iz]! + 8.7;
        dummy.position.set(x, 0.26, z);
        dummy.rotation.set(0, 0, 0);
        dummy.scale.set(1, 1, 1);
        dummy.updateMatrix();
        poles.setMatrixAt(nodeIndex, dummy.matrix);
        housings.setMatrixAt(nodeIndex, dummy.matrix);

        for (let lamp = 0; lamp < 2; lamp++) {
          dummy.position.set(x, 4.38 - lamp * 0.47, z + 0.21);
          dummy.updateMatrix();
          this.signalLightMesh.setMatrixAt(lampIndex, dummy.matrix);
          this.signalLightMesh.setColorAt(lampIndex, tempColor.setRGB(0.2, 0.2, 0.2));
          lampIndex++;
        }
      }
    }
    poles.instanceMatrix.needsUpdate = true;
    housings.instanceMatrix.needsUpdate = true;
    this.signalLightMesh.instanceMatrix.needsUpdate = true;
    if (this.signalLightMesh.instanceColor) this.signalLightMesh.instanceColor.needsUpdate = true;
    this.updateSignalVisuals();
  }

  private updateSignalVisuals(): void {
    const lines = this.plan.roadLines.length;
    let cursor = 0;
    for (let iz = 0; iz < lines; iz++) {
      for (let ix = 0; ix < lines; ix++) {
        const vertical = this.getSignal(ix, iz, false, this.elapsed);
        const horizontal = this.getSignal(ix, iz, true, this.elapsed);
        this.signalLightMesh.setColorAt(cursor++, this.signalColor(vertical));
        this.signalLightMesh.setColorAt(cursor++, this.signalColor(horizontal));
      }
    }
    if (this.signalLightMesh.instanceColor) this.signalLightMesh.instanceColor.needsUpdate = true;
  }

  private signalColor(state: SignalState): THREE.Color {
    if (state === 'green') return tempColor.setRGB(0.25, 2.1, 0.95);
    if (state === 'amber') return tempColor.setRGB(2.2, 1.0, 0.18);
    return tempColor.setRGB(2.2, 0.12, 0.16);
  }
}

const dummy = new THREE.Object3D();
const tempColor = new THREE.Color();

function mergeSimpleBufferGeometry(a: THREE.BufferGeometry, b: THREE.BufferGeometry): THREE.BufferGeometry {
  const position: number[] = [];
  const normal: number[] = [];
  const uv: number[] = [];
  for (const geometry of [a, b]) {
    const pos = geometry.getAttribute('position');
    const nor = geometry.getAttribute('normal');
    const tex = geometry.getAttribute('uv');
    for (let i = 0; i < pos.count; i++) {
      position.push(pos.getX(i), pos.getY(i), pos.getZ(i));
      normal.push(nor.getX(i), nor.getY(i), nor.getZ(i));
      uv.push(tex.getX(i), tex.getY(i));
    }
  }
  const merged = new THREE.BufferGeometry();
  merged.setAttribute('position', new THREE.Float32BufferAttribute(position, 3));
  merged.setAttribute('normal', new THREE.Float32BufferAttribute(normal, 3));
  merged.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  return merged;
}
