import type { BuildingPlan, CameraPreset, CityPlan, DemoState, WeatherKind } from '../types';
import { clamp } from '../utils/random';
import { DemoStore } from '../app/store';

export interface UIActions {
  enterCity(): void;
  setTime(hours: number): void;
  setTimePaused(paused: boolean): void;
  cycleTimeScale(): void;
  setWeather(weather: WeatherKind): void;
  setAutoWeather(enabled: boolean): void;
  triggerPulse(): void;
  toggleTour(): void;
  toggleRush(): void;
  toggleMode(): void;
  setCameraPreset(preset: CameraPreset): void;
  focusSelected(): void;
  pulseFromSelected(): void;
  selectBuilding(id: string | null): void;
  toggleAudio(): void;
  togglePhotoMode(): void;
  setBloom(enabled: boolean): void;
  setShadows(enabled: boolean): void;
  setQuality(quality: DemoState['quality']): void;
  virtualMove(x: number, y: number): void;
  virtualLift(value: number): void;
}

const WEATHER_LABELS: Record<WeatherKind, string> = {
  clear: 'CLEAR',
  rain: 'RAIN',
  storm: 'STORM',
  snow: 'SNOW',
  fog: 'FOG',
};

const ICONS = {
  sound: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9H4Z"/><path d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12"/></svg>`,
  muted: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9H4Z"/><path d="m16 9 5 6m0-6-5 6"/></svg>`,
  help: `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M9.7 9a2.5 2.5 0 1 1 3.1 3.1c-.9.4-.8 1.2-.8 2.1M12 17.2v.1"/></svg>`,
  fullscreen: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 4H4v4M16 4h4v4M8 20H4v-4M16 20h4v-4"/></svg>`,
  camera: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8.5h3l1.4-2h7.2l1.4 2h3v9H4v-9Z"/><circle cx="12" cy="13" r="3.2"/></svg>`,
  close: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>`,
  arrow: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h13M13 6l6 6-6 6"/></svg>`,
  play: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 9 6-9 6V6Z"/></svg>`,
  pause: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 6v12M16 6v12"/></svg>`,
  target: `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="6.5"/><circle cx="12" cy="12" r="1.8"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/></svg>`,
  sliders: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/></svg>`,
};

function formatClock(hours: number): string {
  const safe = ((hours % 24) + 24) % 24;
  const h = Math.floor(safe);
  const m = Math.floor((safe - h) * 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function formatSpeed(scale: number): string {
  if (scale === 0) return 'HOLD';
  return scale < 1 ? `${scale.toFixed(1)}×` : `${scale.toFixed(0)}×`;
}

function phaseName(hours: number): string {
  if (hours < 4.7) return 'DEEP NIGHT';
  if (hours < 6.8) return 'DAWN';
  if (hours < 11) return 'MORNING';
  if (hours < 16) return 'DAYLIGHT';
  if (hours < 18.7) return 'GOLDEN HOUR';
  if (hours < 20.8) return 'DUSK';
  return 'NIGHT';
}

function districtLabel(district: string): string {
  return district.charAt(0).toUpperCase() + district.slice(1);
}

export class UI {
  private readonly store: DemoStore;
  private readonly actions: UIActions;
  private readonly root: HTMLElement;
  private readonly timeSlider: HTMLInputElement;
  private readonly clockLarge: HTMLElement;
  private readonly topClock: HTMLElement;
  private readonly phaseLabel: HTMLElement;
  private readonly playButton: HTMLButtonElement;
  private readonly speedButton: HTMLButtonElement;
  private readonly autoWeatherButton: HTMLButtonElement;
  private readonly modeButton: HTMLButtonElement;
  private readonly rushButton: HTMLButtonElement;
  private readonly tourButton: HTMLButtonElement;
  private readonly audioButton: HTMLButtonElement;
  private readonly hoverTag: HTMLElement;
  private readonly inspector: HTMLElement;
  private readonly intro: HTMLElement;
  private readonly help: HTMLElement;
  private readonly graphicsPanel: HTMLElement;
  private readonly graphicsButton: HTMLButtonElement;
  private readonly bloomButton: HTMLButtonElement;
  private readonly shadowsButton: HTMLButtonElement;
  private readonly toasts: HTMLElement;
  private readonly feedList: HTMLElement;
  private readonly weatherButtons = new Map<WeatherKind, HTMLButtonElement>();
  private readonly presetButtons = new Map<CameraPreset, HTMLButtonElement>();
  private readonly qualityButtons = new Map<DemoState['quality'], HTMLButtonElement>();
  private readonly joystick: HTMLElement;
  private lastState: DemoState;
  private selectedBuilding: BuildingPlan | null = null;
  private sliderActive = false;
  private joystickPointer: number | null = null;
  private helpOpen = false;
  private graphicsOpen = false;
  private audioOn = false;
  private telemetry: string[] = [];

  constructor(store: DemoStore, root: HTMLElement, actions: UIActions) {
    this.store = store;
    this.root = root;
    this.actions = actions;
    this.lastState = store.state;
    this.root.innerHTML = this.template();
    this.timeSlider = this.must<HTMLInputElement>('#time-slider');
    this.clockLarge = this.must('#clock-large');
    this.topClock = this.must('#top-clock');
    this.phaseLabel = this.must('#phase-label');
    this.playButton = this.must<HTMLButtonElement>('#btn-play');
    this.speedButton = this.must<HTMLButtonElement>('#btn-speed');
    this.autoWeatherButton = this.must<HTMLButtonElement>('#btn-auto-weather');
    this.modeButton = this.must<HTMLButtonElement>('#btn-mode');
    this.rushButton = this.must<HTMLButtonElement>('#btn-rush');
    this.tourButton = this.must<HTMLButtonElement>('#btn-tour');
    this.audioButton = this.must<HTMLButtonElement>('#btn-audio');
    this.hoverTag = this.must('#hover-tag');
    this.inspector = this.must('#inspector');
    this.intro = this.must('#intro');
    this.help = this.must('#help-overlay');
    this.graphicsPanel = this.must('#graphics-panel');
    this.graphicsButton = this.must<HTMLButtonElement>('#btn-graphics');
    this.bloomButton = this.must<HTMLButtonElement>('#btn-bloom');
    this.shadowsButton = this.must<HTMLButtonElement>('#btn-shadows');
    this.toasts = this.must('#toasts');
    this.feedList = this.must('#telemetry-feed');
    this.joystick = this.must('#joystick');

    for (const quality of ['auto', 'high', 'low'] as DemoState['quality'][]) {
      const button = this.must<HTMLButtonElement>(`#quality-${quality}`);
      this.qualityButtons.set(quality, button);
    }

    for (const weather of Object.keys(WEATHER_LABELS) as WeatherKind[]) {
      const button = this.must<HTMLButtonElement>(`#weather-${weather}`);
      this.weatherButtons.set(weather, button);
      button.addEventListener('click', () => this.actions.setWeather(weather));
    }
    for (const preset of ['skyline', 'street', 'core'] as CameraPreset[]) {
      const button = this.must<HTMLButtonElement>(`#preset-${preset}`);
      this.presetButtons.set(preset, button);
      button.addEventListener('click', () => this.actions.setCameraPreset(preset));
    }

    this.bindControls();
    this.bindJoystick();
    this.store.subscribe((state) => this.sync(state));
    this.addInitialTelemetry();
    window.setInterval(() => this.rotateTelemetry(), 12000);
  }

  private template(): string {
    const weatherButtons = (Object.keys(WEATHER_LABELS) as WeatherKind[])
      .map(
        (weather) => `
        <button class="weather-button" id="weather-${weather}" data-weather="${weather}" aria-label="Set weather to ${weather}">
          <i class="weather-glyph weather-${weather}"></i>
          <span>${WEATHER_LABELS[weather]}</span>
        </button>`,
      )
      .join('');

    return `
      <div class="screen-vignette" aria-hidden="true"></div>
      <div class="screen-grain" aria-hidden="true"></div>
      <div class="screen-scanlines" aria-hidden="true"></div>

      <header class="topbar hud-layer">
        <div class="brand-lockup">
          <svg class="brand-mark" viewBox="0 0 40 40" aria-hidden="true">
            <path d="M20 3 35 12v16L20 37 5 28V12L20 3Z" />
            <path d="M20 10.5 29 16v8l-9 5.5L11 24v-8l9-5.5Z" />
            <path d="M20 16v8M16 18l8 4M24 18l-8 4" />
          </svg>
          <div class="brand-type">
            <span>DEEPSEEK</span>
            <strong>HYPERCITY</strong>
          </div>
        </div>
        <div class="live-strip">
          <span class="live-dot"></span>
          <span>SIMULATION ONLINE</span>
          <span class="hairline"></span>
          <span id="top-weather">CLEAR SKIES</span>
          <span class="hairline"></span>
          <span id="top-clock">18:00</span>
        </div>
        <div class="top-actions">
          <button class="icon-button" id="btn-graphics" aria-label="Graphics settings" aria-expanded="false" title="Graphics settings (G)">
            ${ICONS.sliders}
          </button>
          <button class="icon-button" id="btn-photo" aria-label="Photo mode" title="Photo mode (F)">
            ${ICONS.camera}
          </button>
          <button class="icon-button" id="btn-audio" aria-label="Toggle ambient audio" title="Ambient audio (M)">
            ${ICONS.muted}
          </button>
          <button class="icon-button" id="btn-fullscreen" aria-label="Toggle fullscreen" title="Fullscreen">
            ${ICONS.fullscreen}
          </button>
          <button class="icon-button" id="btn-help" aria-label="Show controls" title="Controls (H)">
            ${ICONS.help}
          </button>
        </div>
      </header>

      <aside class="graphics-panel" id="graphics-panel" aria-label="Graphics settings" aria-hidden="true">
        <div class="graphics-heading">
          <span>GRAPHICS / LIVE</span>
          <button class="icon-button graphics-close" id="btn-graphics-close" aria-label="Close graphics settings">${ICONS.close}</button>
        </div>
        <div class="settings-row">
          <div class="settings-label"><b>BLOOM</b><small>NEON & LIGHT BLEED</small></div>
          <button class="settings-toggle" id="btn-bloom" aria-pressed="true"><i></i><span>ON</span></button>
        </div>
        <div class="settings-row">
          <div class="settings-label"><b>SHADOWS</b><small>SUN / SKYLINE DEPTH</small></div>
          <button class="settings-toggle" id="btn-shadows" aria-pressed="true"><i></i><span>ON</span></button>
        </div>
        <div class="settings-row settings-row-stack">
          <div class="settings-label"><b>RENDER SCALE</b><small>RESOLUTION / GPU LOAD</small></div>
          <div class="quality-switch">
            <button id="quality-auto" data-quality="auto">AUTO</button>
            <button id="quality-high" data-quality="high">HIGH</button>
            <button id="quality-low" data-quality="low">LOW</button>
          </div>
        </div>
        <p class="graphics-note">Higher settings trade GPU headroom for atmosphere. Changes apply immediately.</p>
      </aside>

      <aside class="sector-readout hud-layer" aria-hidden="true">
        <div class="readout-kicker">SECTOR / 05</div>
        <div class="readout-title">NEURAL CORE<br />MONITORING</div>
        <div class="readout-row"><span>GRID</span><b>COHERENT</b></div>
        <div class="readout-row"><span>SKYLINE</span><b>NOMINAL</b></div>
        <div class="readout-row"><span>WEATHER</span><b id="readout-weather">CLEAR</b></div>
        <div class="readout-bars" aria-hidden="true">
          <i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i>
        </div>
      </aside>

      <section class="telemetry hud-layer" aria-live="polite">
        <div class="telemetry-head"><span>LIVE FEED</span><span>SYNC 99.7</span></div>
        <div id="telemetry-feed" class="telemetry-feed"></div>
      </section>

      <section class="bottom-dock hud-layer" aria-label="City controls">
        <div class="dock-panel time-panel">
          <div class="panel-heading">
            <span>CHRONO / 24H</span>
            <span class="panel-accent" id="phase-label">DUSK</span>
          </div>
          <div class="time-row">
            <button class="play-button" id="btn-play" aria-label="Pause time" aria-pressed="false"></button>
            <div class="time-readout">
              <div class="clock-large" id="clock-large">18:00</div>
              <div class="time-sub">LOCAL <span class="signal-dot"></span></div>
            </div>
            <div class="time-controls">
              <div class="slider-wrap">
                <div class="slider-track-labels"><span>00</span><span>06</span><span>12</span><span>18</span><span>24</span></div>
                <input id="time-slider" class="time-slider" type="range" min="0" max="24" step="0.01" value="18.0" aria-label="Time of day" />
              </div>
              <button class="speed-button" id="btn-speed" title="Cycle time speed">1×</button>
            </div>
          </div>
          <div class="time-presets">
            <button data-time="6.2">DAWN</button>
            <button data-time="12.5">NOON</button>
            <button data-time="17.95">DUSK</button>
            <button data-time="23.2">NIGHT</button>
          </div>
        </div>

        <div class="dock-panel weather-panel">
          <div class="panel-heading">
            <span>ATMOSPHERE</span>
            <button class="toggle-button" id="btn-auto-weather" aria-pressed="false">AUTO</button>
          </div>
          <div class="weather-grid">${weatherButtons}</div>
          <div class="weather-hint" id="weather-hint">Pressure stable · visibility 9.2 km</div>
        </div>

        <div class="dock-panel action-panel">
          <div class="panel-heading">
            <span>SYSTEMS</span>
            <span class="panel-meta" id="vehicle-count">092 VEHICLES</span>
          </div>
          <div class="action-grid">
            <button class="action-button pulse-action" id="btn-pulse" title="Neural pulse (N)">
              <span class="action-symbol">◉</span>
              <span><b>NEURAL PULSE</b><small>SYNC THE GRID</small></span>
            </button>
            <button class="action-button" id="btn-tour" title="Cinematic tour (C)">
              <span class="action-symbol">▶</span>
              <span><b>CINEMATIC</b><small>ENTER THE FLOW</small></span>
            </button>
            <button class="action-button" id="btn-rush" title="Traffic surge (T)">
              <span class="action-symbol">⇢</span>
              <span><b>RUSH HOUR</b><small>FLOOD THE STREETS</small></span>
            </button>
            <button class="action-button" id="btn-mode" title="Toggle fly / walk (V)">
              <span class="action-symbol">✥</span>
              <span><b>FLY MODE</b><small>FREE CAMERA</small></span>
            </button>
          </div>
          <div class="preset-row">
            <span class="preset-label">VIEW</span>
            <button id="preset-skyline">SKYLINE</button>
            <button id="preset-street">STREET</button>
            <button id="preset-core">CORE</button>
            <span class="fps-read" id="fps-read">60 FPS</span>
          </div>
        </div>
      </section>

      <div class="control-hint hud-layer">
        <span><b>WASD</b> FLY</span>
        <span><b>DRAG</b> LOOK</span>
        <span><b>SCROLL</b> SPEED</span>
        <span><b>CLICK</b> INSPECT</span>
        <span><b>V</b> WALK</span>
        <span class="hint-fill"></span>
        <span class="seed-label">SEED <b id="seed-value">7319</b></span>
      </div>

      <aside class="inspector" id="inspector" aria-hidden="true">
        <div class="inspector-glow" aria-hidden="true"></div>
        <button class="icon-button inspector-close" id="btn-inspector-close" aria-label="Close inspector">${ICONS.close}</button>
        <div class="inspector-kicker"><span id="inspect-district">CORE</span> / STRUCTURE</div>
        <h2 id="inspect-name">MERIDIAN SPIRE</h2>
        <p class="inspector-tenant" id="inspect-tenant">DEEPSEEK RESEARCH</p>
        <div class="inspector-stats">
          <div><span>HEIGHT</span><b id="inspect-height">206 M</b></div>
          <div><span>FLOORS</span><b id="inspect-floors">58</b></div>
          <div><span>YEAR</span><b id="inspect-year">2071</b></div>
        </div>
        <div class="meter-block">
          <div class="meter-label"><span>OCCUPANCY</span><b id="inspect-occupancy">96%</b></div>
          <div class="meter"><i id="meter-occupancy"></i></div>
        </div>
        <div class="meter-block">
          <div class="meter-label"><span>GRID LOAD</span><b id="inspect-energy">99%</b></div>
          <div class="meter"><i id="meter-energy"></i></div>
        </div>
        <div class="inspector-actions">
          <button class="inspector-primary" id="btn-focus">FOCUS CAMERA ${ICONS.target}</button>
          <button class="inspector-secondary" id="btn-pulse-sector">PULSE FROM SECTOR</button>
        </div>
      </aside>

      <div class="hover-tag" id="hover-tag" aria-hidden="true"><b></b><span></span></div>
      <div class="toast-stack" id="toasts" aria-live="polite"></div>

      <div class="touch-ui" id="touch-ui">
        <div class="joystick" id="joystick" aria-label="Movement joystick">
          <div class="joystick-ring"></div>
          <div class="joystick-knob" id="joystick-knob"></div>
          <span class="joystick-label">MOVE</span>
        </div>
        <div class="lift-controls">
          <button id="btn-lift-up" aria-label="Ascend">↑</button>
          <button id="btn-lift-down" aria-label="Descend">↓</button>
        </div>
      </div>

      <section class="intro-overlay" id="intro" aria-label="Welcome to Hypercity">
        <div class="intro-noise" aria-hidden="true"></div>
        <header class="intro-top">
          <div class="intro-mark">
            <span class="intro-mark-line"></span>
            <span>DEEPSEEK</span>
          </div>
          <div class="intro-top-right">
            <span>REAL-TIME SYSTEMS DEMO</span>
            <span>EST. 2026</span>
          </div>
        </header>
        <div class="intro-main">
          <div class="intro-copy">
            <div class="eyebrow"><span></span> A LIVING NEURAL METROPOLIS</div>
            <h1><span>HYPER</span><span class="outline">CITY</span></h1>
            <p>
              An infinite city, generated in real time. Walk its streets, command the sky,
              summon the weather, and feel the grid breathe.
            </p>
            <div class="intro-cta-row">
              <button class="enter-button" id="btn-enter" aria-label="Enter Hypercity">
                <span class="enter-icon">${ICONS.arrow}</span>
                <span><b>ENTER HYPERCITY</b><small>FLY / WALK / WITNESS</small></span>
              </button>
              <span class="intro-note">Drag to look once inside.<br />No install. No loading wall.</span>
            </div>
            <div class="intro-stats">
              <div><b id="stat-buildings">208</b><span>STRUCTURES</span></div>
              <div><b>11 × 11</b><span>CITY GRID</span></div>
              <div><b>05</b><span>WEATHER MODES</span></div>
              <div><b>∞</b><span>POSSIBILITIES</span></div>
            </div>
          </div>
          <div class="intro-side">
            <div class="intro-card">
              <div class="intro-card-head"><span>NEURAL CORE</span><i class="live-dot"></i></div>
              <div class="core-orbit">
                <span></span><span></span><span></span><i></i>
              </div>
              <div class="intro-card-foot"><span>CORE SYNC</span><b>99.84%</b></div>
            </div>
            <div class="intro-side-note">
              <span>01 — GENERATE</span>
              <span>02 — EXPLORE</span>
              <span>03 — DISRUPT</span>
            </div>
          </div>
        </div>
        <footer class="intro-footer">
          <span>WEBGL2 / REAL-TIME RENDER</span>
          <span>SEED <b id="intro-seed">7319</b></span>
          <span class="intro-footer-line"></span>
          <span>WASD · DRAG · CLICK · WEATHER · TIME · PULSE</span>
        </footer>
      </section>

      <section class="help-overlay" id="help-overlay" aria-hidden="true">
        <div class="modal-card">
          <button class="icon-button modal-close" id="btn-help-close" aria-label="Close controls">${ICONS.close}</button>
          <div class="eyebrow"><span></span> CONTROLS / COMMANDS</div>
          <h2>MOVE THE CITY.</h2>
          <div class="help-grid">
            <div><kbd>W A S D</kbd><span>Move / strafe</span></div>
            <div><kbd>Q / E</kbd><span>Descend / ascend</span></div>
            <div><kbd>DRAG</kbd><span>Look around</span></div>
            <div><kbd>SCROLL</kbd><span>Adjust flight speed</span></div>
            <div><kbd>SHIFT</kbd><span>Boost</span></div>
            <div><kbd>V</kbd><span>Fly / walk</span></div>
            <div><kbd>CLICK</kbd><span>Inspect building / pulse core</span></div>
            <div><kbd>N</kbd><span>Neural pulse</span></div>
            <div><kbd>C</kbd><span>Cinematic tour</span></div>
            <div><kbd>T</kbd><span>Traffic surge</span></div>
            <div><kbd>M</kbd><span>Ambient audio</span></div>
            <div><kbd>G</kbd><span>Graphics settings</span></div>
            <div><kbd>F</kbd><span>Photo mode</span></div>
            <div><kbd>H</kbd><span>Help</span></div>
            <div><kbd>ESC</kbd><span>Close / exit tour</span></div>
          </div>
          <div class="help-footer">A procedural city built for the browser. Everything you see is generated at runtime.</div>
        </div>
      </section>

      <section class="photo-badge" aria-hidden="true"><span>PHOTO MODE</span><b>F TO EXIT</b></section>

      <button class="mobile-controls-toggle" id="btn-mobile-controls" aria-expanded="false">CITY CONTROLS</button>

      <div class="tour-frame" aria-hidden="true">
        <div class="letterbox top"></div>
        <div class="letterbox bottom"></div>
        <div class="tour-title"><span>DEEPSEEK // HYPERCITY</span><b>CINEMATIC FLIGHT</b></div>
        <button class="tour-exit" id="btn-tour-exit">EXIT TOUR <span>ESC</span></button>
      </div>
    `;
  }

  private bindControls(): void {
    this.must('#btn-enter').addEventListener('click', () => this.actions.enterCity());
    this.playButton.addEventListener('click', () => this.actions.setTimePaused(!this.lastState.timePaused));
    this.speedButton.addEventListener('click', () => this.actions.cycleTimeScale());
    this.timeSlider.addEventListener('input', () => {
      this.actions.setTime(Number(this.timeSlider.value));
    });
    this.timeSlider.addEventListener('pointerdown', () => {
      this.sliderActive = true;
    });
    const finishSlide = () => {
      this.sliderActive = false;
    };
    this.timeSlider.addEventListener('pointerup', finishSlide);
    this.timeSlider.addEventListener('pointercancel', finishSlide);
    this.timeSlider.addEventListener('change', finishSlide);
    document.querySelectorAll<HTMLButtonElement>('[data-time]').forEach((button) => {
      button.addEventListener('click', () => {
        const hours = Number(button.dataset.time);
        if (Number.isFinite(hours)) this.actions.setTime(hours);
      });
    });
    this.autoWeatherButton.addEventListener('click', () => this.actions.setAutoWeather(!this.lastState.autoWeather));
    this.must('#btn-pulse').addEventListener('click', () => this.actions.triggerPulse());
    this.tourButton.addEventListener('click', () => this.actions.toggleTour());
    this.rushButton.addEventListener('click', () => this.actions.toggleRush());
    this.modeButton.addEventListener('click', () => this.actions.toggleMode());
    this.audioButton.addEventListener('click', () => this.actions.toggleAudio());
    this.must('#btn-photo').addEventListener('click', () => this.actions.togglePhotoMode());
    this.graphicsButton.addEventListener('click', () => this.toggleGraphics(!this.graphicsOpen));
    this.must('#btn-graphics-close').addEventListener('click', () => this.toggleGraphics(false));
    this.bloomButton.addEventListener('click', () => this.actions.setBloom(!this.lastState.bloomEnabled));
    this.shadowsButton.addEventListener('click', () => this.actions.setShadows(!this.lastState.shadowsEnabled));
    for (const [quality, button] of this.qualityButtons) {
      button.addEventListener('click', () => this.actions.setQuality(quality));
    }
    document.addEventListener('pointerdown', (event) => {
      if (!this.graphicsOpen) return;
      const target = event.target as Node;
      if (!this.graphicsPanel.contains(target) && !this.graphicsButton.contains(target)) {
        this.toggleGraphics(false);
      }
    });
    this.must('#btn-fullscreen').addEventListener('click', () => this.toggleFullscreen());
    this.must('#btn-help').addEventListener('click', () => this.toggleHelp(true));
    this.must('#btn-help-close').addEventListener('click', () => this.toggleHelp(false));
    this.must('#btn-tour-exit').addEventListener('click', () => this.actions.toggleTour());
    this.must('#btn-inspector-close').addEventListener('click', () => this.actions.selectBuilding(null));
    this.must('#btn-focus').addEventListener('click', () => this.actions.focusSelected());
    this.must('#btn-pulse-sector').addEventListener('click', () => this.actions.pulseFromSelected());
    this.must('#btn-mobile-controls').addEventListener('click', () => {
      const open = !document.body.classList.contains('deck-open');
      document.body.classList.toggle('deck-open', open);
      const toggle = this.must<HTMLButtonElement>('#btn-mobile-controls');
      toggle.textContent = open ? 'CLOSE CONTROLS' : 'CITY CONTROLS';
      toggle.setAttribute('aria-expanded', String(open));
    });
    this.help.addEventListener('click', (event) => {
      if (event.target === this.help) this.toggleHelp(false);
    });
  }

  private bindJoystick(): void {
    const knob = this.must('#joystick-knob');
    const updateJoystick = (event: PointerEvent) => {
      const rect = this.joystick.getBoundingClientRect();
      const x = event.clientX - (rect.left + rect.width / 2);
      const y = event.clientY - (rect.top + rect.height / 2);
      const max = rect.width * 0.34;
      const length = Math.hypot(x, y);
      const scale = length > max ? max / length : 1;
      const nx = x * scale;
      const ny = y * scale;
      knob.style.transform = `translate(${nx}px, ${ny}px)`;
      this.actions.virtualMove(nx / max, ny / max);
    };
    const stopJoystick = () => {
      this.joystickPointer = null;
      knob.style.transform = 'translate(0px, 0px)';
      this.actions.virtualMove(0, 0);
    };
    this.joystick.addEventListener('pointerdown', (event) => {
      this.joystickPointer = event.pointerId;
      this.joystick.setPointerCapture(event.pointerId);
      updateJoystick(event);
    });
    this.joystick.addEventListener('pointermove', (event) => {
      if (this.joystickPointer === event.pointerId) updateJoystick(event);
    });
    this.joystick.addEventListener('pointerup', stopJoystick);
    this.joystick.addEventListener('pointercancel', stopJoystick);
    const liftUp = this.must<HTMLButtonElement>('#btn-lift-up');
    const liftDown = this.must<HTMLButtonElement>('#btn-lift-down');
    const bindLift = (element: HTMLButtonElement, value: number) => {
      element.addEventListener('pointerdown', (event) => {
        event.preventDefault();
        element.setPointerCapture(event.pointerId);
        this.actions.virtualLift(value);
      });
      const stop = () => this.actions.virtualLift(0);
      element.addEventListener('pointerup', stop);
      element.addEventListener('pointercancel', stop);
      element.addEventListener('pointerleave', stop);
    };
    bindLift(liftUp, 1);
    bindLift(liftDown, -1);
  }

  private toggleFullscreen(): void {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen?.().catch(() => undefined);
    } else {
      document.exitFullscreen?.().catch(() => undefined);
    }
  }

  private sync(state: DemoState): void {
    this.lastState = state;
    const time = formatClock(state.timeHours);
    this.clockLarge.textContent = time;
    this.topClock.textContent = time;
    this.phaseLabel.textContent = phaseName(state.timeHours);
    this.playButton.innerHTML = state.timePaused ? ICONS.play : ICONS.pause;
    this.playButton.setAttribute('aria-label', state.timePaused ? 'Resume time' : 'Pause time');
    this.playButton.setAttribute('aria-pressed', String(state.timePaused));
    this.playButton.classList.toggle('is-paused', state.timePaused);
    this.speedButton.textContent = formatSpeed(state.timeScale);
    this.timeSlider.style.setProperty('--progress', `${(state.timeHours / 24) * 100}%`);
    if (!this.sliderActive) this.timeSlider.value = String(state.timeHours);
    this.autoWeatherButton.classList.toggle('is-active', state.autoWeather);
    this.autoWeatherButton.setAttribute('aria-pressed', String(state.autoWeather));
    for (const [weather, button] of this.weatherButtons) {
      button.classList.toggle('is-active', weather === state.weather);
    }
    this.must('#top-weather').textContent = `${WEATHER_LABELS[state.weather]} SKIES`;
    this.must('#readout-weather').textContent = WEATHER_LABELS[state.weather];
    this.weatherHint(state.weather);
    this.rushButton.classList.toggle('is-active', state.trafficProfile === 'rush');
    this.rushButton.querySelector('b')!.textContent = state.trafficProfile === 'rush' ? 'RUSH ACTIVE' : 'RUSH HOUR';
    this.tourButton.classList.toggle('is-active', state.cameraMode === 'tour');
    const walk = state.cameraMode === 'walk';
    this.modeButton.querySelector('b')!.textContent = walk ? 'WALK MODE' : 'FLY MODE';
    this.modeButton.querySelector('small')!.textContent = walk ? 'STREET LEVEL' : 'FREE CAMERA';
    this.modeButton.querySelector('.action-symbol')!.textContent = walk ? '⌖' : '✥';
    this.audioOn = state.audioEnabled;
    this.audioButton.innerHTML = state.audioEnabled ? ICONS.sound : ICONS.muted;
    this.audioButton.classList.toggle('is-active', state.audioEnabled);
    this.bloomButton.classList.toggle('is-on', state.bloomEnabled);
    this.bloomButton.setAttribute('aria-pressed', String(state.bloomEnabled));
    this.bloomButton.querySelector('span')!.textContent = state.bloomEnabled ? 'ON' : 'OFF';
    this.shadowsButton.classList.toggle('is-on', state.shadowsEnabled);
    this.shadowsButton.setAttribute('aria-pressed', String(state.shadowsEnabled));
    this.shadowsButton.querySelector('span')!.textContent = state.shadowsEnabled ? 'ON' : 'OFF';
    for (const [quality, button] of this.qualityButtons) {
      button.classList.toggle('is-active', state.quality === quality);
    }
    this.must('#seed-value').textContent = String(state.seed);
    this.must('#intro-seed').textContent = String(state.seed);
    document.body.classList.toggle('intro-open', state.introOpen);
    document.body.classList.toggle('photo-mode', state.photoMode);
    document.body.classList.toggle('tour-mode', state.cameraMode === 'tour');
    document.body.classList.toggle('walk-mode', state.cameraMode === 'walk');
    if (state.introOpen || state.cameraMode === 'tour' || state.photoMode) {
      document.body.classList.remove('deck-open');
      const mobileToggle = this.must<HTMLButtonElement>('#btn-mobile-controls');
      mobileToggle.textContent = 'CITY CONTROLS';
      mobileToggle.setAttribute('aria-expanded', 'false');
      if (this.graphicsOpen) this.toggleGraphics(false);
    }
    this.intro.classList.toggle('is-hidden', !state.introOpen);
    this.intro.setAttribute('aria-hidden', String(!state.introOpen));
    if (state.introOpen) document.body.classList.remove('hud-ready');
    else document.body.classList.add('hud-ready');
    if (state.cameraMode === 'tour') {
      this.tourButton.classList.add('is-active');
    }
    if (!state.selectedBuildingId && this.selectedBuilding) {
      this.hideInspector();
    }
    if (state.photoMode) this.toggleHelp(false);
  }

  private weatherHint(weather: WeatherKind): void {
    const phrases: Record<WeatherKind, string> = {
      clear: 'Pressure stable · visibility 9.2 km',
      rain: 'Precipitation 68% · roads reflective',
      storm: 'Electrical activity · seek shelter',
      snow: 'Surface −4°C · soft visibility',
      fog: 'Visibility 1.1 km · density rising',
    };
    const element = this.must('#weather-hint');
    element.textContent = phrases[weather];
  }

  setIntroStats(plan: CityPlan): void {
    this.must('#stat-buildings').textContent = String(plan.buildings.length).padStart(3, '0');
  }

  hideLoading(): void {
    const loading = document.getElementById('loading');
    if (!loading) return;
    loading.classList.add('is-hidden');
    window.setTimeout(() => loading.remove(), 900);
  }

  enterPressed(): void {
    const button = this.must<HTMLButtonElement>('#btn-enter');
    button.classList.add('is-pressed');
    button.blur();
  }

  showInspector(building: BuildingPlan): void {
    this.selectedBuilding = building;
    this.must('#inspect-district').textContent = building.district.toUpperCase();
    this.must('#inspect-name').textContent = building.name;
    this.must('#inspect-tenant').textContent = building.tenant;
    this.must('#inspect-height').textContent = `${Math.round(building.height)} M`;
    this.must('#inspect-floors').textContent = String(building.floors);
    this.must('#inspect-year').textContent = String(building.built);
    this.must('#inspect-occupancy').textContent = `${building.occupancy}%`;
    this.must('#inspect-energy').textContent = `${building.energy}%`;
    this.must('#meter-occupancy').style.width = `${building.occupancy}%`;
    this.must('#meter-energy').style.width = `${building.energy}%`;
    this.inspector.classList.add('is-open');
    this.inspector.setAttribute('aria-hidden', 'false');
    this.hideHover();
  }

  hideInspector(): void {
    this.selectedBuilding = null;
    this.inspector.classList.remove('is-open');
    this.inspector.setAttribute('aria-hidden', 'true');
  }

  showHover(label: string, sublabel: string, x: number, y: number): void {
    if (this.lastState.photoMode || this.lastState.introOpen || this.lastState.cameraMode === 'tour') return;
    this.hoverTag.querySelector('b')!.textContent = label;
    this.hoverTag.querySelector('span')!.textContent = sublabel;
    this.hoverTag.style.left = `${x + 18}px`;
    this.hoverTag.style.top = `${y + 18}px`;
    this.hoverTag.classList.add('is-visible');
  }

  hideHover(): void {
    this.hoverTag.classList.remove('is-visible');
  }

  showToast(title: string, detail: string, variant: 'accent' | 'warm' = 'accent'): void {
    const toast = document.createElement('div');
    toast.className = `toast toast-${variant}`;
    toast.innerHTML = `<i></i><div><b></b><span></span></div>`;
    toast.querySelector('b')!.textContent = title;
    toast.querySelector('span')!.textContent = detail;
    this.toasts.appendChild(toast);
    window.setTimeout(() => toast.classList.add('is-visible'), 20);
    window.setTimeout(() => {
      toast.classList.remove('is-visible');
      window.setTimeout(() => toast.remove(), 500);
    }, 4200);
    while (this.toasts.children.length > 3) this.toasts.firstElementChild?.remove();
  }

  setRuntimeStatus(fps: number, vehicles: number): void {
    this.must('#fps-read').textContent = `${Math.round(fps)} FPS`;
    this.must('#vehicle-count').textContent = `${String(vehicles).padStart(3, '0')} VEHICLES`;
  }

  updateWeatherHint(): void {
    this.weatherHint(this.lastState.weather);
  }

  pushTelemetry(message: string): void {
    this.telemetry.unshift(message);
    this.telemetry = this.telemetry.slice(0, 6);
    this.renderTelemetry();
  }

  private addInitialTelemetry(): void {
    this.telemetry = [
      'CORE UPLINK ESTABLISHED',
      'TRAFFIC LATTICE SYNCHRONISED',
      'WEATHER ENGINE ONLINE',
    ];
    this.renderTelemetry();
  }

  private rotateTelemetry(): void {
    if (this.lastState.introOpen) return;
    const messages = [
      'SECTOR 05 WINDOW LATTICE RECALIBRATED',
      'NEURAL CORE OUTPUT WITHIN NOMINAL RANGE',
      'MONORAIL LOOP 02 PASSING EAST SPUR',
      'ATMOSPHERIC PRESSURE STEADY',
      'GRID TRAFFIC FLOW OPTIMISED',
    ];
    const next = messages[Math.floor(Math.random() * messages.length)]!;
    this.pushTelemetry(next);
  }

  private renderTelemetry(): void {
    this.feedList.innerHTML = this.telemetry
      .slice(0, 3)
      .map((message, index) => `<div class="feed-line" style="opacity:${1 - index * 0.26}"><i></i><span>${escapeHtml(message)}</span></div>`)
      .join('');
  }

  toggleHelp(open: boolean): void {
    this.helpOpen = open;
    if (open) this.toggleGraphics(false);
    this.help.classList.toggle('is-open', open);
    this.help.setAttribute('aria-hidden', String(!open));
  }

  toggleGraphics(open: boolean): void {
    this.graphicsOpen = open;
    if (open) this.toggleHelp(false);
    this.graphicsPanel.classList.toggle('is-open', open);
    this.graphicsPanel.setAttribute('aria-hidden', String(!open));
    this.graphicsButton.classList.toggle('is-active', open);
    this.graphicsButton.setAttribute('aria-expanded', String(open));
  }

  handleEscape(): boolean {
    if (this.graphicsOpen) {
      this.toggleGraphics(false);
      return true;
    }
    if (this.helpOpen) {
      this.toggleHelp(false);
      return true;
    }
    if (this.selectedBuilding) {
      this.actions.selectBuilding(null);
      return true;
    }
    return false;
  }

  get isHelpOpen(): boolean {
    return this.helpOpen;
  }

  get isGraphicsOpen(): boolean {
    return this.graphicsOpen;
  }

  private must<T extends Element = HTMLElement>(selector: string): T {
    const element = this.root.querySelector<T>(selector);
    if (!element) throw new Error(`UI element not found: ${selector}`);
    return element;
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function formatDistrict(district: string): string {
  return districtLabel(district);
}

export function clampTime(hours: number): number {
  return clamp(hours, 0, 24);
}
