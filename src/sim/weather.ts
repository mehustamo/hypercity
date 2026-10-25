import * as THREE from 'three';
import type { WeatherConfig, WeatherKind } from '../types';
import { clamp, damp, mulberry32, range, smoothstep } from '../utils/random';
import { makeGlowTexture, makeSoftDotTexture } from '../utils/textures';

export const WEATHER_CONFIGS: Record<WeatherKind, WeatherConfig> = {
  clear: {
    cloud: 0.24,
    fog: 0.07,
    wet: 0.02,
    rain: 0,
    snow: 0,
    wind: 0.18,
    storm: 0,
    lightning: false,
    exposure: 1.05,
    sunDim: 1,
    ambient: 1,
  },
  rain: {
    cloud: 0.78,
    fog: 0.42,
    wet: 0.86,
    rain: 1,
    snow: 0,
    wind: 0.4,
    storm: 0.12,
    lightning: false,
    exposure: 0.96,
    sunDim: 0.48,
    ambient: 0.9,
  },
  storm: {
    cloud: 0.98,
    fog: 0.68,
    wet: 1,
    rain: 1.45,
    snow: 0,
    wind: 0.92,
    storm: 1,
    lightning: true,
    exposure: 0.86,
    sunDim: 0.2,
    ambient: 0.72,
  },
  snow: {
    cloud: 0.78,
    fog: 0.56,
    wet: 0.32,
    rain: 0,
    snow: 1,
    wind: 0.46,
    storm: 0.04,
    lightning: false,
    exposure: 1,
    sunDim: 0.52,
    ambient: 0.94,
  },
  fog: {
    cloud: 0.48,
    fog: 1,
    wet: 0.3,
    rain: 0,
    snow: 0,
    wind: 0.1,
    storm: 0,
    lightning: false,
    exposure: 0.94,
    sunDim: 0.36,
    ambient: 0.86,
  },
};

interface RainDrop {
  x: number;
  y: number;
  z: number;
  speed: number;
  length: number;
}

interface SnowFlake {
  x: number;
  y: number;
  z: number;
  speed: number;
  drift: number;
  phase: number;
}

interface Ripple {
  x: number;
  z: number;
  age: number;
  duration: number;
}

const RAIN_COUNT = 3600;
const SNOW_COUNT = 2600;
const RIPPLE_COUNT = 72;
const MAX_THUNDER_DELAY = 2.4;

export class WeatherSystem {
  readonly group = new THREE.Group();
  onThunder: ((strength: number) => void) | null = null;

  private kind: WeatherKind = 'clear';
  private current: WeatherConfig;
  private from: WeatherConfig;
  private to: WeatherConfig;
  private transition = 1;

  private readonly rng = mulberry32(0x77ea7e5);
  private readonly rainDrops: RainDrop[] = [];
  private readonly rainPositions: Float32Array;
  private readonly rainGeometry: THREE.BufferGeometry;
  private readonly rainMesh: THREE.LineSegments;
  private readonly rainMaterial: THREE.LineBasicMaterial;

  private readonly snowFlakes: SnowFlake[] = [];
  private readonly snowPositions: Float32Array;
  private readonly snowGeometry: THREE.BufferGeometry;
  private readonly snowMesh: THREE.Points;
  private readonly snowMaterial: THREE.PointsMaterial;

  private readonly ripplesData: Ripple[] = [];
  private readonly rippleMesh: THREE.InstancedMesh;
  private readonly rippleMaterial: THREE.MeshBasicMaterial;

  private readonly boltGroup = new THREE.Group();
  private bolt: THREE.LineSegments | null = null;
  private boltMaterial: THREE.LineBasicMaterial | null = null;
  private boltAge = 99;
  private flash = 0;
  private nextLightning = 4.2;
  private pendingThunder: { delay: number; strength: number }[] = [];
  private cameraPosition = new THREE.Vector3();
  private cameraForward = new THREE.Vector3(0, 0, -1);
  private elapsed = 0;

  constructor() {
    this.current = { ...WEATHER_CONFIGS.clear };
    this.from = { ...WEATHER_CONFIGS.clear };
    this.to = { ...WEATHER_CONFIGS.clear };
    this.group.name = 'weather';

    this.rainPositions = new Float32Array(RAIN_COUNT * 2 * 3);
    this.rainGeometry = new THREE.BufferGeometry();
    const rainPositionAttribute = new THREE.BufferAttribute(this.rainPositions, 3);
    rainPositionAttribute.setUsage(THREE.DynamicDrawUsage);
    this.rainGeometry.setAttribute('position', rainPositionAttribute);
    this.rainGeometry.setDrawRange(0, 0);
    this.rainMaterial = new THREE.LineBasicMaterial({
      color: 0xa6c8df,
      transparent: true,
      opacity: 0.34,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
      fog: true,
    });
    this.rainMesh = new THREE.LineSegments(this.rainGeometry, this.rainMaterial);
    this.rainMesh.frustumCulled = false;
    this.rainMesh.visible = false;
    this.group.add(this.rainMesh);
    for (let i = 0; i < RAIN_COUNT; i++) {
      this.rainDrops.push({
        x: 0,
        y: -100,
        z: 0,
        speed: range(this.rng, 28, 52),
        length: range(this.rng, 0.8, 2.1),
      });
    }

    this.snowPositions = new Float32Array(SNOW_COUNT * 3);
    this.snowGeometry = new THREE.BufferGeometry();
    const snowPositionAttribute = new THREE.BufferAttribute(this.snowPositions, 3);
    snowPositionAttribute.setUsage(THREE.DynamicDrawUsage);
    this.snowGeometry.setAttribute('position', snowPositionAttribute);
    this.snowGeometry.setDrawRange(0, 0);
    this.snowMaterial = new THREE.PointsMaterial({
      color: 0xe8f3ff,
      map: makeSoftDotTexture(48),
      size: 0.55,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
      sizeAttenuation: true,
      toneMapped: false,
      fog: true,
    });
    this.snowMesh = new THREE.Points(this.snowGeometry, this.snowMaterial);
    this.snowMesh.frustumCulled = false;
    this.snowMesh.visible = false;
    this.group.add(this.snowMesh);
    for (let i = 0; i < SNOW_COUNT; i++) {
      this.snowFlakes.push({
        x: 0,
        y: -100,
        z: 0,
        speed: range(this.rng, 1.7, 4.2),
        drift: range(this.rng, 0.3, 1.4),
        phase: range(this.rng, 0, Math.PI * 2),
      });
    }

    this.ripplesData = [];
    for (let i = 0; i < RIPPLE_COUNT; i++) {
      this.ripplesData.push({ x: 0, z: 0, age: range(this.rng, 0, 2), duration: range(this.rng, 0.7, 1.7) });
    }
    const rippleGeometry = new THREE.RingGeometry(0.93, 1, 20);
    this.rippleMaterial = new THREE.MeshBasicMaterial({
      color: 0xa9ddff,
      transparent: true,
      opacity: 0.7,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    });
    this.rippleMesh = new THREE.InstancedMesh(rippleGeometry, this.rippleMaterial, RIPPLE_COUNT);
    this.rippleMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.rippleMesh.frustumCulled = false;
    this.rippleMesh.visible = false;
    this.group.add(this.rippleMesh);
    const rippleColor = new THREE.Color();
    for (let i = 0; i < RIPPLE_COUNT; i++) this.rippleMesh.setColorAt(i, rippleColor.setScalar(0));
    if (this.rippleMesh.instanceColor) this.rippleMesh.instanceColor.setUsage(THREE.DynamicDrawUsage);

    this.boltGroup.name = 'lightning';
    this.group.add(this.boltGroup);
  }

  get config(): Readonly<WeatherConfig> {
    return this.current;
  }

  get activeWeather(): WeatherKind {
    return this.kind;
  }

  setWeather(kind: WeatherKind, immediate = false): void {
    this.kind = kind;
    this.from = { ...this.current };
    this.to = { ...WEATHER_CONFIGS[kind] };
    this.transition = immediate ? 1 : 0;
    if (immediate) {
      this.current = { ...this.to };
    }
    if (kind === 'storm' && this.nextLightning > 6) {
      this.nextLightning = range(this.rng, 3.2, 6.4);
    }
    if (kind !== 'storm') {
      this.nextLightning = 5;
    }
  }

  forceLightning(): void {
    this.triggerLightning();
  }

  update(dt: number, elapsed: number, camera: THREE.PerspectiveCamera): void {
    this.elapsed = elapsed;
    this.cameraPosition.copy(camera.position);
    camera.getWorldDirection(this.cameraForward);
    const clampedDt = Math.min(dt, 0.06);

    if (this.transition < 1) {
      this.transition = Math.min(1, this.transition + clampedDt / 5.5);
      const smooth = smoothstep(0, 1, this.transition);
      interpolateWeather(this.current, this.from, this.to, smooth);
      if (this.transition >= 1) this.current = { ...this.to };
    }

    this.updateRain(clampedDt);
    this.updateSnow(clampedDt);
    this.updateRipples(clampedDt);
    this.updateLightning(clampedDt);
    this.updateThunder(clampedDt);
  }

  private updateRain(dt: number): void {
    const rainIntensity = clamp(this.current.rain, 0, 1.4);
    const active = rainIntensity > 0.01 ? Math.floor(RAIN_COUNT * Math.min(1, rainIntensity)) : 0;
    if (active === 0) {
      this.rainMesh.visible = false;
      return;
    }
    this.rainMesh.visible = true;
    this.rainMaterial.opacity = 0.22 + Math.min(1, rainIntensity) * 0.24;
    const positions = this.rainPositions;
    const windX = this.current.wind * 7.2;
    const windZ = this.current.wind * 2.3;
    const cam = this.cameraPosition;
    for (let i = 0; i < active; i++) {
      const drop = this.rainDrops[i]!;
      if (drop.y < -1 || Math.abs(drop.x - cam.x) > 95 || Math.abs(drop.z - cam.z) > 95) {
        this.respawnRain(drop, cam);
      }
      drop.y -= drop.speed * dt;
      drop.x += windX * dt;
      drop.z += windZ * dt;
      const index = i * 6;
      positions[index] = drop.x;
      positions[index + 1] = drop.y;
      positions[index + 2] = drop.z;
      positions[index + 3] = drop.x - windX * 0.035;
      positions[index + 4] = drop.y + drop.length;
      positions[index + 5] = drop.z - windZ * 0.035;
    }
    this.rainGeometry.setDrawRange(0, active * 2);
    const attribute = this.rainGeometry.getAttribute('position') as THREE.BufferAttribute;
    attribute.needsUpdate = true;
  }

  private respawnRain(drop: RainDrop, camera: THREE.Vector3): void {
    const angle = this.rng() * Math.PI * 2;
    const distance = range(this.rng, 9, 82);
    drop.x = camera.x + Math.cos(angle) * distance;
    drop.z = camera.z + Math.sin(angle) * distance;
    drop.y = Math.max(3, camera.y + range(this.rng, -12, 55));
    drop.speed = range(this.rng, 28, 54);
    drop.length = range(this.rng, 0.8, 2.1);
  }

  private updateSnow(dt: number): void {
    const snowIntensity = clamp(this.current.snow, 0, 1);
    const active = snowIntensity > 0.01 ? Math.floor(SNOW_COUNT * snowIntensity) : 0;
    if (active === 0) {
      this.snowMesh.visible = false;
      return;
    }
    this.snowMesh.visible = true;
    this.snowMaterial.opacity = 0.35 + snowIntensity * 0.55;
    const positions = this.snowPositions;
    const cam = this.cameraPosition;
    for (let i = 0; i < active; i++) {
      const flake = this.snowFlakes[i]!;
      if (flake.y < 0.2 || Math.abs(flake.x - cam.x) > 90 || Math.abs(flake.z - cam.z) > 90) {
        flake.x = cam.x + range(this.rng, -80, 80);
        flake.z = cam.z + range(this.rng, -80, 80);
        flake.y = Math.max(6, cam.y + range(this.rng, -8, 48));
      }
      flake.y -= flake.speed * dt;
      flake.x += Math.sin(this.elapsed * 0.45 + flake.phase) * flake.drift * dt + this.current.wind * 2.6 * dt;
      flake.z += Math.cos(this.elapsed * 0.33 + flake.phase) * flake.drift * 0.7 * dt;
      positions[i * 3] = flake.x;
      positions[i * 3 + 1] = flake.y;
      positions[i * 3 + 2] = flake.z;
    }
    this.snowGeometry.setDrawRange(0, active);
    const attribute = this.snowGeometry.getAttribute('position') as THREE.BufferAttribute;
    attribute.needsUpdate = true;
  }

  private updateRipples(dt: number): void {
    const active = this.current.rain > 0.06 && this.current.wet > 0.15;
    this.rippleMesh.visible = active;
    if (!active) return;
    this.rippleMaterial.opacity = 0.3;
    const cam = this.cameraPosition;
    for (let i = 0; i < RIPPLE_COUNT; i++) {
      const ripple = this.ripplesData[i]!;
      ripple.age += dt;
      if (ripple.age > ripple.duration) {
        ripple.age = 0;
        ripple.duration = range(this.rng, 0.75, 1.8);
        ripple.x = cam.x + range(this.rng, -24, 24);
        ripple.z = cam.z + range(this.rng, -24, 24);
      }
      const t = ripple.age / ripple.duration;
      const scale = 0.1 + t * 0.62;
      dummy.position.set(ripple.x, 0.07, ripple.z);
      dummy.rotation.set(-Math.PI / 2, 0, 0);
      dummy.scale.set(scale, scale, scale);
      dummy.updateMatrix();
      this.rippleMesh.setMatrixAt(i, dummy.matrix);
      this.rippleMesh.setColorAt(i, tempRippleColor.setScalar((1 - t) * 0.12));
    }
    this.rippleMesh.instanceMatrix.needsUpdate = true;
    if (this.rippleMesh.instanceColor) this.rippleMesh.instanceColor.needsUpdate = true;
  }

  private updateLightning(dt: number): void {
    const stormy = this.current.storm > 0.38;
    if (!stormy) {
      this.flash = damp(this.flash, 0, 15, dt);
      this.nextLightning = Math.max(this.nextLightning, 4);
      return;
    }
    this.nextLightning -= dt;
    if (this.nextLightning <= 0) {
      this.triggerLightning();
      this.nextLightning = range(this.rng, 9, 21);
    }
    this.boltAge += dt;
    if (this.boltAge > 0.7) this.flash = damp(this.flash, 0, 18, dt);
    if (this.boltMaterial) this.boltMaterial.opacity = Math.max(0, 1 - this.boltAge / 0.55);
    if (this.bolt && this.boltAge > 0.9) {
      this.boltGroup.remove(this.bolt);
      this.bolt.geometry.dispose();
      this.bolt = null;
      this.boltMaterial = null;
    }
  }

  private updateThunder(dt: number): void {
    for (let i = this.pendingThunder.length - 1; i >= 0; i--) {
      const pending = this.pendingThunder[i]!;
      pending.delay -= dt;
      if (pending.delay <= 0) {
        this.onThunder?.(pending.strength);
        this.pendingThunder.splice(i, 1);
      }
    }
  }

  private triggerLightning(): void {
    const forwardAngle = Math.atan2(this.cameraForward.x, this.cameraForward.z);
    const strikeAngle = forwardAngle + range(this.rng, -0.75, 0.75);
    const distance = range(this.rng, 250, 600);
    const baseX = this.cameraPosition.x + Math.sin(strikeAngle) * distance;
    const baseZ = this.cameraPosition.z + Math.cos(strikeAngle) * distance;
    const topY = range(this.rng, 190, 300);
    const endY = range(this.rng, 65, 130);
    const segments: number[] = [];
    const points: THREE.Vector3[] = [];
    const steps = 14;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const jitter = (1 - t) * 30;
      points.push(
        new THREE.Vector3(
          baseX + (this.rng() - 0.5) * jitter,
          topY + (endY - topY) * t,
          baseZ + (this.rng() - 0.5) * jitter,
        ),
      );
    }
    for (let i = 0; i < points.length - 1; i++) {
      const a = points[i]!;
      const b = points[i + 1]!;
      segments.push(a.x, a.y, a.z, b.x, b.y, b.z);
      if (i > 3 && i < points.length - 3 && this.rng() < 0.38) {
        const branchEnd = b.clone().add(
          new THREE.Vector3(
            range(this.rng, -50, 50),
            range(this.rng, -35, 15),
            range(this.rng, -50, 50),
          ),
        );
        segments.push(b.x, b.y, b.z, branchEnd.x, branchEnd.y, branchEnd.z);
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(segments, 3));
    this.boltMaterial = new THREE.LineBasicMaterial({
      color: 0xdcecff,
      transparent: true,
      opacity: 1,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false,
      toneMapped: false,
    });
    this.bolt = new THREE.LineSegments(geometry, this.boltMaterial);
    this.bolt.frustumCulled = false;
    this.boltGroup.add(this.bolt);
    this.boltAge = 0;
    this.flash = 1;
    this.pendingThunder.push({
      delay: range(this.rng, 0.55, MAX_THUNDER_DELAY),
      strength: clamp(1 - distance / 900, 0.35, 1),
    });
  }

  get lightningFlash(): number {
    return this.flash;
  }
}

const dummy = new THREE.Object3D();
const tempRippleColor = new THREE.Color();

function interpolateWeather(current: WeatherConfig, from: WeatherConfig, to: WeatherConfig, t: number): void {
  current.cloud = from.cloud + (to.cloud - from.cloud) * t;
  current.fog = from.fog + (to.fog - from.fog) * t;
  current.wet = from.wet + (to.wet - from.wet) * t;
  current.rain = from.rain + (to.rain - from.rain) * t;
  current.snow = from.snow + (to.snow - from.snow) * t;
  current.wind = from.wind + (to.wind - from.wind) * t;
  current.storm = from.storm + (to.storm - from.storm) * t;
  current.exposure = from.exposure + (to.exposure - from.exposure) * t;
  current.sunDim = from.sunDim + (to.sunDim - from.sunDim) * t;
  current.ambient = from.ambient + (to.ambient - from.ambient) * t;
  current.lightning = t > 0.5 ? to.lightning : from.lightning;
}
