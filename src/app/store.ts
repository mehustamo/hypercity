import type { CameraMode, DemoState, WeatherKind } from '../types';
import { clamp } from '../utils/random';

type Listener = (state: DemoState) => void;

const VALID_WEATHER: readonly WeatherKind[] = ['clear', 'rain', 'storm', 'snow', 'fog'];

export interface UrlOptions {
  skipIntro: boolean;
  startTour: boolean;
  lightningDebug: boolean;
}

function numberParam(params: URLSearchParams, key: string): number | null {
  const raw = params.get(key);
  if (raw === null || raw.trim() === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function boolParam(params: URLSearchParams, key: string): boolean | null {
  const raw = params.get(key);
  if (raw === null) return null;
  return raw === '1' || raw === 'true' || raw === 'yes';
}

export function parseUrlOptions(): UrlOptions {
  const params = new URLSearchParams(window.location.search);
  return {
    skipIntro: boolParam(params, 'skipIntro') ?? false,
    startTour: boolParam(params, 'tour') ?? false,
    lightningDebug: boolParam(params, 'lightning') ?? false,
  };
}

export function createInitialState(): DemoState {
  const params = new URLSearchParams(window.location.search);
  const seed = numberParam(params, 'seed') ?? 7319;
  const timeHours = clamp(numberParam(params, 'time') ?? 19.25, 0, 24);
  const weatherParam = params.get('weather');
  const weather = VALID_WEATHER.includes(weatherParam as WeatherKind)
    ? (weatherParam as WeatherKind)
    : 'clear';
  const skipIntro = boolParam(params, 'skipIntro') ?? false;
  const timeScale = clamp(numberParam(params, 'timeScale') ?? 1, 0, 24);
  const paused = boolParam(params, 'paused') ?? false;
  const modeParam = params.get('mode');
  const cameraMode: CameraMode = params.get('tour') === '1' ? 'tour' : modeParam === 'walk' ? 'walk' : 'fly';
  const qualityParam = params.get('quality');
  const quality = qualityParam === 'high' || qualityParam === 'low' ? qualityParam : 'auto';

  return {
    seed: Math.abs(Math.floor(seed)) >>> 0,
    timeHours,
    timeScale,
    timePaused: paused || timeScale === 0,
    weather,
    autoWeather: boolParam(params, 'autoWeather') ?? true,
    selectedBuildingId: null,
    cameraMode,
    trafficProfile: params.get('traffic') === 'rush' ? 'rush' : 'normal',
    audioEnabled: false,
    photoMode: boolParam(params, 'photo') ?? false,
    introOpen: !skipIntro,
    quality,
    bloomEnabled: boolParam(params, 'bloom') ?? true,
    shadowsEnabled: boolParam(params, 'shadows') ?? quality !== 'low',
  };
}

export class DemoStore {
  readonly state: DemoState;
  private listeners = new Set<Listener>();

  constructor(initial: DemoState) {
    this.state = { ...initial };
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  set(patch: Partial<DemoState>, notify = true): void {
    Object.assign(this.state, patch);
    if (notify) this.emit();
  }

  setTime(hours: number): void {
    this.set({ timeHours: ((hours % 24) + 24) % 24 });
  }

  advanceTime(deltaSeconds: number): void {
    if (this.state.timePaused) return;
    const hours = this.state.timeHours + (deltaSeconds / 480) * 24 * this.state.timeScale;
    this.state.timeHours = ((hours % 24) + 24) % 24;
  }

  emit(): void {
    for (const listener of this.listeners) listener(this.state);
  }
}
