import type { WeatherConfig } from '../types';

export class AudioEngine {
  private context: AudioContext | null = null;
  private master: GainNode | null = null;
  private ambientGain: GainNode | null = null;
  private rainGain: GainNode | null = null;
  private windGain: GainNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  private enabled = false;
  private weather: WeatherConfig | null = null;

  get isEnabled(): boolean {
    return this.enabled;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (enabled) {
      this.ensureStarted();
      if (this.context && this.master) {
        this.context.resume().catch(() => undefined);
        const now = this.context.currentTime;
        this.master.gain.cancelScheduledValues(now);
        this.master.gain.setTargetAtTime(0.52, now, 0.35);
      }
    } else if (this.context && this.master) {
      const now = this.context.currentTime;
      this.master.gain.cancelScheduledValues(now);
      this.master.gain.setTargetAtTime(0, now, 0.18);
    }
  }

  setWeather(weather: WeatherConfig): void {
    this.weather = weather;
    if (!this.context || !this.rainGain || !this.windGain || !this.ambientGain) return;
    const now = this.context.currentTime;
    this.rainGain.gain.setTargetAtTime(Math.min(0.2, weather.rain * 0.11), now, 0.6);
    this.windGain.gain.setTargetAtTime(Math.min(0.12, weather.wind * 0.09 + weather.storm * 0.02), now, 0.7);
    this.ambientGain.gain.setTargetAtTime(0.11 + weather.storm * 0.035, now, 0.8);
  }

  pulse(): void {
    if (!this.enabled) return;
    this.ensureStarted();
    const context = this.context;
    const master = this.master;
    if (!context || !master) return;
    const now = context.currentTime;
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(96, now);
    oscillator.frequency.exponentialRampToValueAtTime(38, now + 1.6);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.22, now + 0.07);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 2.1);
    oscillator.connect(gain).connect(master);
    oscillator.start(now);
    oscillator.stop(now + 2.2);
  }

  thunder(strength: number): void {
    if (!this.enabled) return;
    this.ensureStarted();
    const context = this.context;
    const master = this.master;
    const buffer = this.noiseBuffer;
    if (!context || !master || !buffer) return;
    const now = context.currentTime + 0.02;
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = 0.35;
    const filter = context.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(260 + strength * 160, now);
    filter.frequency.exponentialRampToValueAtTime(70, now + 3.4);
    filter.Q.value = 0.8;
    const gain = context.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.5 * strength, now + 0.18);
    gain.gain.exponentialRampToValueAtTime(0.12 * strength, now + 1.1);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 4.6);
    const pan = context.createStereoPanner();
    pan.pan.value = Math.random() * 1.4 - 0.7;
    source.connect(filter).connect(gain).connect(pan).connect(master);
    source.start(now);
    source.stop(now + 5);
  }

  private ensureStarted(): void {
    if (this.context) {
      this.context.resume().catch(() => undefined);
      return;
    }
    const AudioContextClass = window.AudioContext;
    if (!AudioContextClass) return;
    const context = new AudioContextClass();
    this.context = context;
    this.master = context.createGain();
    this.master.gain.value = 0;
    const compressor = context.createDynamicsCompressor();
    compressor.threshold.value = -18;
    compressor.knee.value = 20;
    compressor.ratio.value = 4;
    compressor.attack.value = 0.02;
    compressor.release.value = 0.6;
    this.master.connect(compressor).connect(context.destination);

    this.noiseBuffer = createNoiseBuffer(context, 4);
    const noise = context.createBufferSource();
    noise.buffer = this.noiseBuffer;
    noise.loop = true;

    this.ambientGain = context.createGain();
    this.ambientGain.gain.value = 0.1;
    const ambientFilter = context.createBiquadFilter();
    ambientFilter.type = 'lowpass';
    ambientFilter.frequency.value = 190;
    noise.connect(ambientFilter).connect(this.ambientGain).connect(this.master);

    const hum = context.createOscillator();
    hum.type = 'sine';
    hum.frequency.value = 55;
    const humGain = context.createGain();
    humGain.gain.value = 0.025;
    hum.connect(humGain).connect(this.ambientGain);

    const air = context.createBufferSource();
    air.buffer = this.noiseBuffer;
    air.loop = true;
    air.playbackRate.value = 0.8;
    const airFilter = context.createBiquadFilter();
    airFilter.type = 'bandpass';
    airFilter.frequency.value = 1200;
    airFilter.Q.value = 0.5;
    this.windGain = context.createGain();
    this.windGain.gain.value = 0.03;
    air.connect(airFilter).connect(this.windGain).connect(this.master);

    const rain = context.createBufferSource();
    rain.buffer = this.noiseBuffer;
    rain.loop = true;
    rain.playbackRate.value = 1.6;
    const rainFilter = context.createBiquadFilter();
    rainFilter.type = 'bandpass';
    rainFilter.frequency.value = 2600;
    rainFilter.Q.value = 0.35;
    this.rainGain = context.createGain();
    this.rainGain.gain.value = 0;
    rain.connect(rainFilter).connect(this.rainGain).connect(this.master);

    noise.start();
    hum.start();
    air.start();
    rain.start();
    if (this.weather) this.setWeather(this.weather);
    const now = context.currentTime;
    this.master.gain.setTargetAtTime(this.enabled ? 0.52 : 0, now, 0.35);
  }

  dispose(): void {
    if (this.context) this.context.close().catch(() => undefined);
    this.context = null;
    this.master = null;
    this.noiseBuffer = null;
  }
}

function createNoiseBuffer(context: AudioContext, seconds: number): AudioBuffer {
  const length = Math.floor(context.sampleRate * seconds);
  const buffer = context.createBuffer(2, length, context.sampleRate);
  for (let channel = 0; channel < 2; channel++) {
    const data = buffer.getChannelData(channel);
    let last = 0;
    for (let i = 0; i < length; i++) {
      const white = Math.random() * 2 - 1;
      last = last * 0.985 + white * 0.015;
      data[i] = white * 0.6 + last * 0.8;
    }
  }
  return buffer;
}
