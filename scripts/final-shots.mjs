import { chromium } from 'playwright-core';
import fs from 'node:fs/promises';
import path from 'node:path';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const BASE = 'http://127.0.0.1:5173/';
await fs.mkdir(path.resolve('docs'), { recursive: true });
const browser = await chromium.launch({
  executablePath: EDGE,
  headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu-sandbox', '--hide-scrollbars'],
});

async function capture(query, viewport, file, setup) {
  const page = await browser.newPage({ viewport, deviceScaleFactor: 1, hasTouch: viewport.width < 600 });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.goto(`${BASE}?${query}`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForFunction(() => Boolean(window.hypercity), null, { timeout: 60_000 });
  await page.evaluate(() => window.hypercity.ready);
  await page.waitForTimeout(1400);
  if (setup) await setup(page);
  await page.waitForTimeout(900);
  await page.screenshot({ path: path.resolve('docs', file) });
  console.log(file, 'errors', errors.length, errors.slice(0, 2));
  await page.close();
}

const desktop = { width: 1440, height: 900 };
const mobile = { width: 390, height: 844 };

await capture('skipIntro=1&time=19.25&weather=clear&autoWeather=0&quality=high', desktop, 'preview-city.png');
await capture('skipIntro=1&time=19.25&weather=clear&autoWeather=0&quality=high', desktop, 'preview-core.png', async (page) => {
  await page.evaluate(() => {
    const app = window.hypercityApp;
    app.camera.position.set(28, 14, 28);
    app.camera.lookAt(0, 14.5, 0);
    app.controller.syncAnglesFromCamera();
  });
});
await capture('skipIntro=1&time=21.4&weather=rain&autoWeather=0&quality=high&mode=walk', desktop, 'preview-street.png', async (page) => {
  await page.evaluate(() => {
    const app = window.hypercityApp;
    app.camera.position.set(28, 3, 164);
    app.camera.lookAt(28, 14, 0);
    app.controller.syncAnglesFromCamera();
  });
});
await capture('time=19.25&weather=clear&autoWeather=0&quality=high', desktop, 'preview-intro.png');
await capture('skipIntro=1&time=19.25&weather=clear&autoWeather=0&quality=high', desktop, 'preview-graphics.png', async (page) => {
  await page.click('#btn-graphics');
  await page.waitForTimeout(800);
  await page.click('#btn-bloom');
  await page.waitForTimeout(900);
});
await capture('skipIntro=1&time=19.25&weather=clear&autoWeather=0&quality=high', desktop, 'preview-tour.png', async (page) => {
  await page.click('#btn-tour');
  await page.waitForTimeout(4500);
});
await capture('skipIntro=1&time=21.4&weather=rain&autoWeather=0&quality=low&mode=walk', mobile, 'preview-mobile.png');
await capture('skipIntro=1&time=22.2&weather=storm&autoWeather=0&quality=low', mobile, 'preview-mobile-controls.png', async (page) => {
  await page.click('#btn-mobile-controls');
});
await browser.close();
