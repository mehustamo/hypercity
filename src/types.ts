export type WeatherKind = 'clear' | 'rain' | 'storm' | 'snow' | 'fog';
export type CameraMode = 'fly' | 'walk' | 'tour';
export type CameraPreset = 'skyline' | 'street' | 'core';
export type DistrictKind = 'core' | 'midtown' | 'residential' | 'industrial';
export type BuildingStyle = 'glass' | 'concrete' | 'stone';
export type BlockKind = 'city' | 'park' | 'core' | 'landmark';

export interface DemoState {
  seed: number;
  timeHours: number;
  timeScale: number;
  timePaused: boolean;
  weather: WeatherKind;
  autoWeather: boolean;
  selectedBuildingId: string | null;
  cameraMode: CameraMode;
  trafficProfile: 'normal' | 'rush';
  audioEnabled: boolean;
  photoMode: boolean;
  introOpen: boolean;
  quality: 'auto' | 'high' | 'low';
  bloomEnabled: boolean;
  shadowsEnabled: boolean;
}

export interface Vec3Tuple {
  x: number;
  y: number;
  z: number;
}

export interface BuildingVolume {
  x: number;
  y: number;
  z: number;
  w: number;
  h: number;
  d: number;
  color: number;
  style: BuildingStyle;
}

export interface BuildingPlan {
  id: string;
  name: string;
  blockX: number;
  blockZ: number;
  x: number;
  z: number;
  w: number;
  d: number;
  height: number;
  floors: number;
  district: DistrictKind;
  style: BuildingStyle;
  color: number;
  seed: number;
  volumes: BuildingVolume[];
  hasAntenna: boolean;
  hasHelipad: boolean;
  hasBeacon: boolean;
  hasNeonBand: boolean;
  neonColor: number;
  occupancy: number;
  energy: number;
  built: number;
  tenant: string;
  landmark: boolean;
}

export interface BlockPlan {
  ix: number;
  iz: number;
  x: number;
  z: number;
  size: number;
  kind: BlockKind;
}

export interface TreePlan {
  x: number;
  z: number;
  scale: number;
  hue: number;
}

export interface CityPlan {
  seed: number;
  blocksAcross: number;
  pitch: number;
  blockSize: number;
  roadWidth: number;
  extent: number;
  roadLines: number[];
  blocks: BlockPlan[];
  buildings: BuildingPlan[];
  trees: TreePlan[];
  core: { x: number; z: number; radius: number };
  park: { x: number; z: number; size: number };
  landmark: BuildingPlan | null;
}

export interface WeatherConfig {
  cloud: number;
  fog: number;
  wet: number;
  rain: number;
  snow: number;
  wind: number;
  storm: number;
  lightning: boolean;
  exposure: number;
  sunDim: number;
  ambient: number;
}

export interface SceneLighting {
  sunDirection: { x: number; y: number; z: number };
  moonDirection: { x: number; y: number; z: number };
  nightFactor: number;
  daylight: number;
  golden: number;
  exposure: number;
  fogColor: number;
  fogDensity: number;
  sunIntensity: number;
  moonIntensity: number;
  ambientIntensity: number;
  lightningFlash: number;
}
