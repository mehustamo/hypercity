import './ui/styles.css';
import { HypercityApp, type HypercityApi } from './app/App';

declare global {
  interface Window {
    hypercity: HypercityApi;
  }
}

const loaderProgress = document.getElementById('loader-progress');
const loaderStage = document.getElementById('loader-stage');
const loaderPercent = document.getElementById('loader-percent');
const fatalError = document.getElementById('fatal-error');

function setLoader(percent: number, stage: string): void {
  if (loaderProgress) loaderProgress.style.width = `${percent}%`;
  if (loaderPercent) loaderPercent.textContent = `${String(Math.round(percent)).padStart(2, '0')}%`;
  if (loaderStage) loaderStage.textContent = stage;
}

function fail(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  if (loaderStage) loaderStage.textContent = 'RENDER CORE OFFLINE';
  if (loaderPercent) loaderPercent.textContent = 'ERR';
  if (fatalError) {
    fatalError.hidden = false;
    fatalError.textContent = `The city could not be initialized. ${message} Try a current desktop browser with hardware acceleration enabled.`;
  }
  console.error('[HYPERCITY]', error);
}

async function boot(): Promise<void> {
  setLoader(8, 'BOOTING RENDER CORE');
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  setLoader(22, 'GENERATING CITY GRID');

  let progress = 22;
  const ticker = window.setInterval(() => {
    progress = Math.min(86, progress + Math.random() * 9 + 2);
    setLoader(progress, progress < 48 ? 'RAISING THE SKYLINE' : progress < 70 ? 'CALIBRATING ATMOSPHERE' : 'SPAWNING TRAFFIC LATTICE');
  }, 170);

  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

  const canvas = document.getElementById('world') as HTMLCanvasElement | null;
  const root = document.getElementById('ui');
  if (!canvas || !root) throw new Error('Required page structure is missing.');

  const app = new HypercityApp(canvas, root);
  window.hypercity = app.api();
  (window as Window & { hypercityApp?: HypercityApp }).hypercityApp = app;

  window.clearInterval(ticker);
  setLoader(94, 'SYNCHRONISING NEURAL CORE');
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  setLoader(100, 'CITY ONLINE');
  app.start();
}

boot().catch(fail);
