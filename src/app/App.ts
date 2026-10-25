import * as THREE from 'three';
import type { BuildingPlan, CameraMode, CameraPreset, DemoState, WeatherKind } from '../types';
import { CameraController } from '../camera/controller';
import { CinematicTour } from '../camera/tour';
import { SkySystem, type Atmosphere } from '../render/sky';
import { PostPipeline } from '../render/post';
import { WeatherSystem } from '../sim/weather';
import { TrafficSystem } from '../sim/traffic';
import { CityWorld } from '../world/buildWorld';
import { generateCity } from '../world/generateCity';
import { AudioEngine } from '../audio/engine';
import { UI, type UIActions } from '../ui/ui';
import { DemoStore, createInitialState, parseUrlOptions, type UrlOptions } from './store';

const WEATHER_LABELS: Record<WeatherKind, string> = {
  clear: 'CLEAR SKIES',
  rain: 'RAIN FRONT',
  storm: 'ELECTRICAL STORM',
  snow: 'SNOWFALL',
  fog: 'DENSE FOG',
};

const AUTO_WEATHER_SEQUENCE: WeatherKind[] = ['rain', 'clear', 'storm', 'fog', 'snow', 'clear'];

export interface CityMetrics {
  fps: number;
  drawCalls: number;
  triangles: number;
  vehicles: number;
  cameraPosition: { x: number; y: number; z: number };
}

export interface HypercityApi {
  ready: Promise<void>;
  enter(): void;
  getState(): DemoState;
  setTime(hours: number): void;
  setTimePaused(paused: boolean): void;
  setTimeScale(scale: number): void;
  setWeather(kind: WeatherKind): void;
  setAutoWeather(enabled: boolean): void;
  setCameraPreset(preset: CameraPreset): void;
  setCameraMode(mode: 'fly' | 'walk'): void;
  inspectBuilding(id: string | null): void;
  pulse(): void;
  forceLightning(): void;
  startTour(): void;
  stopTour(): void;
  setTrafficProfile(profile: 'normal' | 'rush'): void;
  setPhotoMode(enabled: boolean): void;
  setAudioEnabled(enabled: boolean): void;
  setBloomEnabled(enabled: boolean): void;
  setShadowsEnabled(enabled: boolean): void;
  setQuality(quality: DemoState['quality']): void;
  getMetrics(): CityMetrics;
}

export class HypercityApp {
  readonly store: DemoStore;
  readonly ready: Promise<void>;

  private readonly canvas: HTMLCanvasElement;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly world: CityWorld;
  private readonly weather: WeatherSystem;
  private readonly traffic: TrafficSystem;
  private readonly sky: SkySystem;
  private readonly post: PostPipeline;
  private readonly controller: CameraController;
  private readonly tour: CinematicTour;
  private readonly audio = new AudioEngine();
  private readonly ui: UI;
  private readonly options: UrlOptions;

  private readonly raycaster = new THREE.Raycaster();
  private readonly pointer = new THREE.Vector2();
  private readonly cameraIntroTarget = new THREE.Vector3(0, 50, 0);
  private readonly tempPosition = new THREE.Vector3();
  private readonly tempTarget = new THREE.Vector3();

  private elapsed = 0;
  private lastFrameTime = 0;
  private introElapsed = 0;
  private autoWeatherTimer = 112;
  private autoWeatherCursor = 0;
  private lastPulseAt = -10;
  private uiTimer = 0;
  private weatherAudioTimer = 0;
  private frameAccumulator = 0;
  private frameCount = 0;
  private measuredFps = 60;
  private resolutionLevel = 0;
  private resolutionLevels: number[] = [1];
  private hoverPending = false;
  private hoverX = 0;
  private hoverY = 0;
  private started = false;
  private firstFrame = true;
  private lightningTimer = 0;
  private debugLightningDone = false;
  private resolveReady!: () => void;
  private metricsDirty = true;

  constructor(canvas: HTMLCanvasElement, uiRoot: HTMLElement) {
    this.canvas = canvas;
    this.store = new DemoStore(createInitialState());
    this.options = parseUrlOptions();
    if (this.options.startTour) this.store.state.introOpen = false;

    const context = canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      depth: true,
      stencil: false,
      powerPreference: 'high-performance',
    });
    if (!context) throw new Error('This experience needs WebGL 2.');
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      context,
      antialias: false,
      alpha: false,
      powerPreference: 'high-performance',
      stencil: false,
    });
    this.renderer.setClearColor(0x03070c, 1);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.enabled = this.store.state.shadowsEnabled;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.info.autoReset = false;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.5, 2600);
    this.camera.position.set(255, 155, 305);
    this.camera.lookAt(this.cameraIntroTarget);

    const plan = generateCity(this.store.state.seed);
    this.world = new CityWorld(plan);
    this.weather = new WeatherSystem();
    this.traffic = new TrafficSystem(plan);
    this.scene.add(this.world.group, this.weather.group, this.traffic.group);
    this.sky = new SkySystem(this.scene, this.renderer);
    this.weather.onThunder = (strength) => this.audio.thunder(strength);

    this.controller = new CameraController(this.camera, canvas, plan);
    this.tour = new CinematicTour(this.camera, plan);
    this.controller.onHover = (x, y) => {
      this.hoverPending = true;
      this.hoverX = x;
      this.hoverY = y;
    };
    this.controller.onHoverEnd = () => {
      this.hoverPending = false;
      this.ui.hideHover();
      this.canvas.style.cursor = this.store.state.introOpen ? 'default' : 'grab';
    };
    this.controller.onPick = (x, y) => this.handlePick(x, y);
    this.controller.onSpeedChanged = (speed) => {
      this.ui.showToast('FLIGHT SPEED', `${speed.toFixed(0)} m/s · scroll to adjust`, 'warm');
    };

    this.weather.setWeather(this.store.state.weather, true);
    this.traffic.setProfile(this.store.state.trafficProfile);

    this.configureResolution();
    this.post = new PostPipeline(
      this.renderer,
      this.scene,
      this.camera,
      window.innerWidth,
      window.innerHeight,
    );
    this.post.setBloom(this.store.state.bloomEnabled);
    this.resize();

    const actions: UIActions = {
      enterCity: () => this.enterCity(),
      setTime: (hours) => this.setTime(hours),
      setTimePaused: (paused) => this.setTimePaused(paused),
      cycleTimeScale: () => this.cycleTimeScale(),
      setWeather: (weather) => this.setWeather(weather, false),
      setAutoWeather: (enabled) => this.setAutoWeather(enabled),
      triggerPulse: () => this.pulse(),
      toggleTour: () => this.toggleTour(),
      toggleRush: () => this.toggleRush(),
      toggleMode: () => this.toggleMode(),
      setCameraPreset: (preset) => this.setCameraPreset(preset),
      focusSelected: () => this.focusSelected(),
      pulseFromSelected: () => this.pulseFromSelected(),
      selectBuilding: (id) => this.selectBuilding(id),
      toggleAudio: () => this.toggleAudio(),
      togglePhotoMode: () => this.togglePhotoMode(),
      setBloom: (enabled) => this.setBloom(enabled),
      setShadows: (enabled) => this.setShadows(enabled),
      setQuality: (quality) => this.setQuality(quality),
      virtualMove: (x, y) => this.controller.setVirtualMove(x, y),
      virtualLift: (value) => this.controller.setVirtualLift(value),
    };
    this.ui = new UI(this.store, uiRoot, actions);
    this.ui.setIntroStats(plan);

    this.setupInitialCamera();
    this.bindEvents();

    this.ready = new Promise<void>((resolve) => {
      this.resolveReady = resolve;
    });

    if (this.options.startTour) {
      window.setTimeout(() => this.startTour(), 120);
    }
    this.ui.pushTelemetry(`SEED ${this.store.state.seed} ONLINE`);
    this.ui.pushTelemetry(`WEATHER ENGINE / ${WEATHER_LABELS[this.store.state.weather]}`);

    if (this.options.lightningDebug) this.lightningTimer = -3.2;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.lastFrameTime = performance.now();
    this.animate();
  }

  private setupInitialCamera(): void {
    const state = this.store.state;
    if (state.introOpen) {
      this.updateIntroCamera(0);
      this.controller.setEnabled(false);
      return;
    }
    if (this.options.startTour) return;
    this.camera.fov = 55;
    this.camera.updateProjectionMatrix();
    if (state.cameraMode === 'walk') {
      this.camera.position.set(28, 2.15, 176);
      this.camera.lookAt(28, 12, 0);
      this.controller.syncAnglesFromCamera();
      this.controller.setMode('walk');
    } else {
      this.camera.position.set(282, 178, 345);
      this.camera.lookAt(0, 54, 0);
      this.controller.beginExploreFromCamera();
    }
  }

  private bindEvents(): void {
    window.addEventListener('resize', this.handleResize);
    window.addEventListener('keydown', this.handleKeyDown);
    this.canvas.addEventListener('pointerdown', this.handleCanvasPointerDown);
    this.canvas.addEventListener('webglcontextlost', this.handleContextLost, false);
    document.addEventListener('visibilitychange', () => {
      this.lastFrameTime = performance.now();
    });
  }

  private handleResize = (): void => {
    this.resize();
  };

  private resize(): void {
    const width = window.innerWidth;
    const height = window.innerHeight;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
    this.post?.setSize(width, height, this.resolutionLevels[this.resolutionLevel] ?? 1);
  }

  private configureResolution(): void {
    const dpr = window.devicePixelRatio || 1;
    const mobile = window.matchMedia('(pointer: coarse)').matches || window.innerWidth < 820;
    let cap: number;
    if (this.store.state.quality === 'low') cap = 1;
    else if (this.store.state.quality === 'high') cap = Math.min(dpr, 2);
    else cap = Math.min(dpr, mobile ? 1.4 : 1.7);
    this.resolutionLevels = [...new Set([cap, Math.min(cap, 1.25), Math.min(cap, 1)])].sort((a, b) => b - a);
    this.resolutionLevel = 0;
    this.renderer.setPixelRatio(this.resolutionLevels[0]!);
  }

  private handleContextLost = (event: Event): void => {
    event.preventDefault();
    this.ui?.showToast('RENDER CORE INTERRUPTED', 'The WebGL context was lost. Refresh to restore the city.', 'warm');
  };

  private handleCanvasPointerDown = (): void => {
    if (this.store.state.cameraMode === 'tour') this.stopTour();
  };

  private handleKeyDown = (event: KeyboardEvent): void => {
    const target = event.target as HTMLElement | null;
    if (
      target &&
      (target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.tagName === 'SELECT' ||
        target.isContentEditable)
    ) {
      return;
    }
    const code = event.code;
    if (this.store.state.introOpen) {
      if (code === 'Enter' || code === 'Space') {
        event.preventDefault();
        this.enterCity();
      }
      return;
    }
    if (this.ui.isHelpOpen) {
      if (code === 'Escape' || code === 'KeyH') {
        event.preventDefault();
        this.ui.toggleHelp(false);
      }
      return;
    }
    if (this.store.state.photoMode) {
      if (code === 'Escape' || code === 'KeyF') {
        event.preventDefault();
        this.togglePhotoMode();
      }
      return;
    }
    if (this.store.state.cameraMode === 'tour') {
      if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'Escape', 'KeyC'].includes(code)) {
        event.preventDefault();
        this.stopTour();
        return;
      }
    }
    if (event.repeat) return;
    switch (code) {
      case 'Escape':
        if (this.ui.handleEscape()) event.preventDefault();
        else this.selectBuilding(null);
        break;
      case 'KeyH':
        event.preventDefault();
        this.ui.toggleHelp(!this.ui.isHelpOpen);
        break;
      case 'KeyN':
      case 'KeyP':
        event.preventDefault();
        this.pulse();
        break;
      case 'KeyC':
        event.preventDefault();
        this.toggleTour();
        break;
      case 'KeyT':
        event.preventDefault();
        this.toggleRush();
        break;
      case 'KeyV':
        event.preventDefault();
        this.toggleMode();
        break;
      case 'KeyM':
        event.preventDefault();
        this.toggleAudio();
        break;
      case 'KeyG':
        event.preventDefault();
        this.ui.toggleGraphics(!this.ui.isGraphicsOpen);
        break;
      case 'KeyF':
        event.preventDefault();
        this.togglePhotoMode();
        break;
      case 'Space':
        event.preventDefault();
        this.setTimePaused(!this.store.state.timePaused);
        break;
      default:
        break;
    }
  };

  private animate = (): void => {
    if (!this.started) return;
    requestAnimationFrame(this.animate);
    const now = performance.now();
    const rawDt = Math.min((now - this.lastFrameTime) / 1000, 0.12);
    this.lastFrameTime = now;
    const dt = Math.min(rawDt, 0.05);
    this.elapsed += dt;
    this.updateClock(dt);
    this.updateAutoWeather(dt);
    this.updateCamera(dt);

    this.weather.update(dt, this.elapsed, this.camera);
    const flash = this.weather.lightningFlash;
    const atmosphere = this.sky.update(
      this.elapsed,
      this.store.state.timeHours,
      this.weather.config,
      flash,
      this.camera.position,
    );
    const sceneFog = this.scene.fog as THREE.FogExp2;
    this.world.setFog(sceneFog.color, sceneFog.density);

    this.world.update(this.elapsed, dt, atmosphere.lightsOn, atmosphere.wetness);
    this.traffic.update(dt, this.elapsed, atmosphere.lightsOn, atmosphere.wetness);
    this.updateHover();
    this.post.update(atmosphere.lightsOn, atmosphere.storm);
    this.renderer.info.reset();
    this.post.render();
    this.metricsDirty = true;
    this.updateInterface(rawDt);
    this.updateDebugLightning(dt);

    if (this.firstFrame) {
      this.firstFrame = false;
      window.setTimeout(() => {
        this.ui.hideLoading();
        this.resolveReady();
      }, 120);
    }
    this.frameAccumulator += rawDt;
    this.frameCount++;
    if (this.frameAccumulator > 3) {
      const fps = this.frameCount / this.frameAccumulator;
      this.measuredFps = fps;
      this.adaptQuality(fps);
      this.frameAccumulator = 0;
      this.frameCount = 0;
    }
  };

  private updateClock(dt: number): void {
    if (!this.store.state.timePaused) this.store.advanceTime(dt);
  }

  private updateAutoWeather(dt: number): void {
    if (!this.store.state.autoWeather) return;
    this.autoWeatherTimer -= dt;
    if (this.autoWeatherTimer <= 0) {
      const next = AUTO_WEATHER_SEQUENCE[this.autoWeatherCursor++ % AUTO_WEATHER_SEQUENCE.length]!;
      this.autoWeatherTimer = 105 + Math.random() * 60;
      this.setWeather(next, true);
    }
  }

  private updateCamera(dt: number): void {
    const state = this.store.state;
    if (state.introOpen) {
      this.updateIntroCamera(dt);
      return;
    }
    if (state.cameraMode === 'tour') {
      this.tour.update(dt);
    } else {
      this.controller.update(dt);
    }
  }

  private updateIntroCamera(dt: number): void {
    this.introElapsed += dt;
    const angle = 0.78 + this.introElapsed * 0.012;
    const radius = 342;
    this.camera.position.set(
      Math.cos(angle) * radius,
      178 + Math.sin(this.introElapsed * 0.11) * 5,
      Math.sin(angle) * radius,
    );
    this.camera.fov = 48;
    this.camera.updateProjectionMatrix();
    this.camera.lookAt(this.cameraIntroTarget);
    this.camera.updateMatrixWorld();
  }

  private updateHover(): void {
    if (!this.hoverPending) return;
    this.hoverPending = false;
    const state = this.store.state;
    if (state.introOpen || state.photoMode || state.cameraMode === 'tour' || document.body.classList.contains('deck-open')) {
      this.ui.hideHover();
      return;
    }
    const rect = this.canvas.getBoundingClientRect();
    this.pointer.set(
      ((this.hoverX - rect.left) / rect.width) * 2 - 1,
      -((this.hoverY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hit = this.world.pick(this.raycaster);
    if (hit?.type === 'building' && hit.building) {
      this.ui.showHover(hit.building.name, `${hit.building.district.toUpperCase()} · ${Math.round(hit.building.height)} M · CLICK TO INSPECT`, this.hoverX, this.hoverY);
      this.canvas.style.cursor = 'pointer';
    } else if (hit?.type === 'core') {
      this.ui.showHover('NEURAL CORE', 'CLICK TO TRIGGER A PULSE', this.hoverX, this.hoverY);
      this.canvas.style.cursor = 'pointer';
    } else {
      this.ui.hideHover();
      this.canvas.style.cursor = 'grab';
    }
  }

  private updateInterface(rawDt: number): void {
    this.uiTimer += rawDt;
    this.weatherAudioTimer += rawDt;
    if (this.weatherAudioTimer > 0.6) {
      this.weatherAudioTimer = 0;
      this.audio.setWeather(this.weather.config);
    }
    if (this.uiTimer > 0.24) {
      this.uiTimer = 0;
      this.store.emit();
      this.ui.setRuntimeStatus(this.measuredFps, this.traffic.activeVehicles);
    }
  }

  private updateDebugLightning(dt: number): void {
    if (!this.options.lightningDebug || this.debugLightningDone) return;
    this.lightningTimer += dt;
    if (this.lightningTimer > 1.2) {
      this.weather.forceLightning();
      this.debugLightningDone = true;
    }
  }

  private adaptQuality(fps: number): void {
    if (this.store.state.quality !== 'auto') return;
    if (fps < 38 && this.resolutionLevel < this.resolutionLevels.length - 1) {
      this.resolutionLevel++;
      this.ui.showToast('PERFORMANCE ADAPTED', 'Render scale reduced to keep the simulation fluid.', 'warm');
      this.resize();
    }
  }

  private handlePick(clientX: number, clientY: number): void {
    if (this.store.state.introOpen || this.store.state.cameraMode === 'tour' || this.store.state.photoMode) return;
    const rect = this.canvas.getBoundingClientRect();
    this.pointer.set(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hit = this.world.pick(this.raycaster);
    if (hit?.type === 'building' && hit.building) {
      this.selectBuilding(hit.building.id);
      return;
    }
    if (hit?.type === 'core') {
      this.selectBuilding(null);
      this.triggerPulseAt(this.world.plan.core.x, this.world.plan.core.z, 'CORE SYNC');
      return;
    }
    this.selectBuilding(null);
  }

  private enterCity(): void {
    if (!this.store.state.introOpen) return;
    this.store.state.introOpen = false;
    this.camera.fov = 55;
    this.camera.updateProjectionMatrix();
    this.controller.beginExploreFromCamera();
    this.ui.enterPressed();
    this.store.emit();
    this.ui.showToast('WELCOME TO HYPERCITY', 'Drag to look · WASD to fly · Click a tower to inspect it', 'accent');
    this.ui.pushTelemetry('CITIZEN LINK ESTABLISHED');
  }

  private setTime(hours: number): void {
    this.store.setTime(hours);
    this.store.emit();
  }

  private setTimePaused(paused: boolean): void {
    this.store.state.timePaused = paused;
    this.store.emit();
  }

  private cycleTimeScale(): void {
    const scales = [1, 2, 4, 0.5];
    const current = this.store.state.timeScale;
    const next = scales[(Math.max(0, scales.indexOf(current)) + 1) % scales.length]!;
    this.store.state.timeScale = next;
    this.store.state.timePaused = false;
    this.store.emit();
    this.ui.showToast('CHRONO SPEED', `${next}× flow · pause from the transport control`, 'warm');
  }

  private setWeather(kind: WeatherKind, auto: boolean): void {
    const state = this.store.state;
    if (state.weather === kind && !auto) return;
    state.weather = kind;
    if (!auto) state.autoWeather = false;
    this.weather.setWeather(kind);
    this.ui.pushTelemetry(`${auto ? 'AUTO WEATHER' : 'WEATHER SYSTEM'} / ${WEATHER_LABELS[kind]}`);
    if (!auto) {
      this.ui.showToast('WEATHER SYNCHRONIZED', `${WEATHER_LABELS[kind]} · atmosphere transitioning`, kind === 'storm' ? 'warm' : 'accent');
    } else {
      this.ui.showToast('AUTO WEATHER', `Incoming ${WEATHER_LABELS[kind].toLowerCase()} · systems adapting`, 'warm');
    }
    this.store.emit();
  }

  private setAutoWeather(enabled: boolean): void {
    this.store.state.autoWeather = enabled;
    this.autoWeatherTimer = enabled ? 52 : this.autoWeatherTimer;
    this.store.emit();
    this.ui.showToast(enabled ? 'WEATHER AUTOMATION ON' : 'WEATHER AUTOMATION OFF', enabled ? 'The city will evolve its own sky.' : 'The current atmosphere is now locked.', enabled ? 'accent' : 'warm');
  }

  private toggleRush(): void {
    const next = this.store.state.trafficProfile === 'rush' ? 'normal' : 'rush';
    this.store.state.trafficProfile = next;
    this.traffic.setProfile(next);
    this.store.emit();
    this.ui.pushTelemetry(next === 'rush' ? 'TRAFFIC SURGE ENGAGED' : 'TRAFFIC FLOW NORMALISED');
    this.ui.showToast(next === 'rush' ? 'RUSH HOUR INITIATED' : 'RUSH HOUR ENDED', next === 'rush' ? '156 vehicles flooding the lattice.' : 'Traffic returning to baseline.', next === 'rush' ? 'warm' : 'accent');
  }

  private toggleMode(): void {
    if (this.store.state.cameraMode === 'tour') {
      this.stopTour();
    }
    const next: CameraMode = this.store.state.cameraMode === 'walk' ? 'fly' : 'walk';
    this.store.state.cameraMode = next;
    this.controller.setMode(next);
    this.store.emit();
    this.ui.showToast(next === 'walk' ? 'STREET LEVEL' : 'FLIGHT MODE', next === 'walk' ? 'Building collision enabled · walk the avenues.' : 'Free flight restored · hold shift to boost.', 'accent');
  }

  private setCameraPreset(preset: CameraPreset): void {
    if (this.store.state.cameraMode === 'tour') this.stopTour();
    this.store.state.cameraMode = 'fly';
    this.controller.setMode('fly');
    this.store.emit();
    this.camera.fov = 55;
    this.camera.updateProjectionMatrix();
    if (preset === 'skyline') {
      this.tempPosition.set(282, 178, 345);
      this.tempTarget.set(0, 54, 0);
      this.controller.flyTo(this.tempPosition, this.tempTarget, 2.4);
      this.ui.showToast('VIEW / SKYLINE', 'High approach over the eastern grid.', 'accent');
    } else if (preset === 'street') {
      this.tempPosition.set(28, 2.35, 164);
      this.tempTarget.set(28, 14, 0);
      this.controller.flyTo(this.tempPosition, this.tempTarget, 2.6);
      this.ui.showToast('VIEW / STREET', 'Merging into the avenue · switch to walk with V.', 'accent');
    } else {
      this.tempPosition.set(28, 14, 28);
      this.tempTarget.set(0, 14.5, 0);
      this.controller.flyTo(this.tempPosition, this.tempTarget, 2.2);
      this.ui.showToast('VIEW / NEURAL CORE', 'Close orbit around the city heart.', 'accent');
    }
    this.ui.hideHover();
  }

  private focusSelected(): void {
    const building = this.world.getBuilding(this.store.state.selectedBuildingId);
    if (!building) return;
    if (this.store.state.cameraMode === 'tour') this.stopTour();
    this.store.state.cameraMode = 'fly';
    this.controller.setMode('fly');
    const target = new THREE.Vector3(building.x, building.height * 0.52, building.z);
    const outX = building.x === 0 && building.z === 0 ? 1 : Math.sign(building.x) || 1;
    const outZ = building.z === 0 ? 1 : Math.sign(building.z) || 1;
    const radius = Math.max(46, Math.min(180, building.height * 0.7));
    const position = new THREE.Vector3(
      target.x + outX * radius * 0.82,
      Math.max(26, building.height * 0.6 + 25),
      target.z + outZ * radius,
    );
    this.controller.flyTo(position, target, 2.1);
    this.store.emit();
    this.ui.showToast('TARGET LOCKED', building.name, 'accent');
  }

  private selectBuilding(id: string | null): void {
    const building = this.world.selectBuilding(id);
    this.store.state.selectedBuildingId = building?.id ?? null;
    if (building) {
      this.ui.showInspector(building);
      this.ui.pushTelemetry(`STRUCTURE / ${building.name}`);
    } else {
      this.ui.hideInspector();
    }
    this.store.emit();
  }

  private pulse(): void {
    this.triggerPulseAt(this.world.plan.core.x, this.world.plan.core.z, 'NEURAL PULSE');
  }

  private pulseFromSelected(): void {
    const building = this.world.getBuilding(this.store.state.selectedBuildingId);
    if (building) {
      this.triggerPulseAt(building.x, building.z, 'SECTOR PULSE');
      return;
    }
    this.pulse();
  }

  private triggerPulseAt(x: number, z: number, label: string): void {
    if (this.elapsed - this.lastPulseAt < 0.85) return;
    this.lastPulseAt = this.elapsed;
    this.world.triggerPulse({ x, z });
    this.audio.pulse();
    this.ui.showToast(label, 'Coherence wave propagating across the city lattice.', 'accent');
    this.ui.pushTelemetry(`${label} / ORIGIN ${x.toFixed(0)},${z.toFixed(0)}`);
  }

  private toggleTour(): void {
    if (this.store.state.introOpen) return;
    if (this.store.state.cameraMode === 'tour') this.stopTour();
    else this.startTour();
  }

  private startTour(): void {
    if (this.store.state.introOpen) {
      this.store.state.introOpen = false;
      this.ui.enterPressed();
    }
    if (this.store.state.photoMode) this.store.state.photoMode = false;
    this.selectBuilding(null);
    this.ui.toggleHelp(false);
    this.ui.hideHover();
    this.store.state.cameraMode = 'tour';
    this.controller.setMode('tour');
    this.tour.start();
    this.store.emit();
    this.ui.pushTelemetry('CINEMATIC FLIGHT ENGAGED');
  }

  private stopTour(): void {
    if (this.store.state.cameraMode !== 'tour') return;
    this.tour.stop();
    this.camera.fov = 55;
    this.camera.updateProjectionMatrix();
    this.store.state.cameraMode = 'fly';
    this.controller.beginExploreFromCamera();
    this.controller.setMode('fly');
    this.store.emit();
    this.ui.showToast('TOUR COMPLETE', 'You are back in control.', 'accent');
  }

  private toggleAudio(): void {
    const next = !this.store.state.audioEnabled;
    this.store.state.audioEnabled = next;
    this.audio.setEnabled(next);
    this.store.emit();
    this.ui.showToast(next ? 'AUDIO LINK ACTIVE' : 'AUDIO LINK MUTED', next ? 'Synthesized city ambience and weather are live.' : 'The simulation continues in silence.', 'accent');
  }

  private setBloom(enabled: boolean): void {
    if (this.store.state.bloomEnabled === enabled) return;
    this.store.state.bloomEnabled = enabled;
    this.post.setBloom(enabled);
    this.store.emit();
    this.ui.showToast(enabled ? 'BLOOM ENABLED' : 'BLOOM DISABLED', enabled ? 'Neon bleed and light halo restored.' : 'Cleaner highlights · lower fill-rate cost.', 'accent');
  }

  private setShadows(enabled: boolean): void {
    if (this.store.state.shadowsEnabled === enabled) return;
    this.store.state.shadowsEnabled = enabled;
    this.renderer.shadowMap.enabled = enabled;
    this.renderer.shadowMap.needsUpdate = true;
    this.store.emit();
    this.ui.showToast(enabled ? 'SHADOWS ENABLED' : 'SHADOWS DISABLED', enabled ? 'Directional shadows are casting again.' : 'Shadow-map pass skipped · faster daylight rendering.', enabled ? 'accent' : 'warm');
  }

  private setQuality(quality: DemoState['quality']): void {
    if (this.store.state.quality === quality) return;
    this.store.state.quality = quality;
    this.configureResolution();
    this.resize();
    this.store.emit();
    this.ui.showToast('RENDER SCALE', quality === 'auto' ? 'Adaptive resolution enabled.' : quality === 'high' ? 'Native / high-resolution rendering.' : 'Reduced resolution for maximum frame rate.', quality === 'low' ? 'warm' : 'accent');
  }

  private setAudioEnabled(enabled: boolean): void {
    if (this.store.state.audioEnabled === enabled) return;
    this.toggleAudio();
  }

  private togglePhotoMode(): void {
    const next = !this.store.state.photoMode;
    this.store.state.photoMode = next;
    if (next) {
      this.ui.toggleHelp(false);
      this.ui.hideHover();
      this.selectBuilding(null);
    }
    this.store.emit();
    if (next) this.ui.showToast('PHOTO MODE', 'Interface concealed. Press F or Escape to return.', 'warm');
  }

  private setPhotoMode(enabled: boolean): void {
    if (this.store.state.photoMode !== enabled) this.togglePhotoMode();
  }

  private getAtmosphere(): Atmosphere {
    return this.sky.update(this.elapsed, this.store.state.timeHours, this.weather.config, this.weather.lightningFlash, this.camera.position);
  }

  getMetrics(): CityMetrics {
    const camera = this.camera.position;
    return {
      fps: this.measuredFps,
      drawCalls: this.renderer.info.render.calls,
      triangles: this.renderer.info.render.triangles,
      vehicles: this.traffic.activeVehicles,
      cameraPosition: { x: camera.x, y: camera.y, z: camera.z },
    };
  }

  /** Public controls exposed through window.hypercity by main.ts. */
  api(): HypercityApi {
    return {
      ready: this.ready,
      enter: () => this.enterCity(),
      getState: () => ({ ...this.store.state }),
      setTime: (hours) => this.setTime(hours),
      setTimePaused: (paused) => this.setTimePaused(paused),
      setTimeScale: (scale) => {
        this.store.state.timeScale = Math.max(0.1, scale);
        this.store.state.timePaused = false;
        this.store.emit();
      },
      setWeather: (kind) => this.setWeather(kind, false),
      setAutoWeather: (enabled) => this.setAutoWeather(enabled),
      setCameraPreset: (preset) => this.setCameraPreset(preset),
      setCameraMode: (mode) => {
        if (mode === this.store.state.cameraMode) return;
        this.store.state.cameraMode = mode;
        this.controller.setMode(mode);
        this.store.emit();
      },
      inspectBuilding: (id) => this.selectBuilding(id),
      pulse: () => this.pulse(),
      forceLightning: () => this.weather.forceLightning(),
      startTour: () => this.startTour(),
      stopTour: () => this.stopTour(),
      setTrafficProfile: (profile) => {
        if (this.store.state.trafficProfile === profile) return;
        this.toggleRush();
      },
      setPhotoMode: (enabled) => this.setPhotoMode(enabled),
      setAudioEnabled: (enabled) => this.setAudioEnabled(enabled),
      setBloomEnabled: (enabled) => this.setBloom(enabled),
      setShadowsEnabled: (enabled) => this.setShadows(enabled),
      setQuality: (quality) => this.setQuality(quality),
      getMetrics: () => this.getMetrics(),
    };
  }
}
