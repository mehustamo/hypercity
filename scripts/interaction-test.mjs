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
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', (error) => errors.push(`PAGEERROR ${error.message}`));
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(`CONSOLE ${message.text()}`);
});

const checks = [];
function check(name, condition, detail = '') {
  checks.push({ name, pass: Boolean(condition), detail });
  console.log(`${condition ? 'PASS' : 'FAIL'} ${name}${detail ? ` :: ${detail}` : ''}`);
}

try {
  await page.goto(`${BASE}?time=19.25&weather=clear&autoWeather=0&quality=high`, {
    waitUntil: 'domcontentloaded',
    timeout: 60_000,
  });
  await page.waitForFunction(() => Boolean(window.hypercity), null, { timeout: 60_000 });
  await page.evaluate(() => window.hypercity.ready);
  await page.waitForTimeout(800);
  check('intro overlay visible', await page.locator('#intro').isVisible());
  await page.screenshot({ path: path.resolve('docs/final-intro.png') });

  await page.click('#btn-enter');
  await page.waitForTimeout(1500);
  check('intro dismissed', await page.evaluate(() => !window.hypercity.getState().introOpen));
  check('HUD is ready', await page.evaluate(() => document.body.classList.contains('hud-ready')));
  await page.screenshot({ path: path.resolve('docs/final-city.png') });

  // Hover and real raycast selection on the tallest hero tower.
  const towerPoint = await page.evaluate(() => {
    const app = window.hypercityApp;
    const building = app.world.getBuilding('landmark');
    const point = app.camera.position.clone();
    point.set(building.x, building.height * 0.52, building.z).project(app.camera);
    const rect = app.canvas.getBoundingClientRect();
    return {
      x: rect.left + ((point.x + 1) / 2) * rect.width,
      y: rect.top + ((1 - point.y) / 2) * rect.height,
    };
  });
  await page.mouse.move(towerPoint.x, towerPoint.y);
  await page.waitForTimeout(900);
  check('hover tag appears over a tower', await page.locator('#hover-tag').evaluate((el) => el.classList.contains('is-visible')));
  await page.mouse.click(towerPoint.x, towerPoint.y);
  await page.waitForTimeout(700);
  check(
    'raycast click selects the tower',
    await page.evaluate(() => window.hypercity.getState().selectedBuildingId === 'landmark'),
  );
  check('landmark inspector opens', await page.locator('#inspector').evaluate((el) => el.classList.contains('is-open')));
  await page.screenshot({ path: path.resolve('docs/final-inspector.png') });
  await page.click('#btn-inspector-close');
  await page.waitForTimeout(300);
  check('inspector closes', await page.evaluate(() => window.hypercity.getState().selectedBuildingId === null));

  await page.locator('#time-slider').evaluate((element) => {
    element.value = '22.5';
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForTimeout(500);
  const changedTime = await page.evaluate(() => window.hypercity.getState().timeHours);
  check('time slider updates scene time', Math.abs(changedTime - 22.5) < 0.04, String(changedTime));

  await page.click('#weather-rain');
  await page.waitForTimeout(900);
  const weather = await page.evaluate(() => window.hypercity.getState().weather);
  check('weather control switches to rain', weather === 'rain', weather);

  await page.click('#btn-pulse');
  await page.waitForTimeout(500);
  check('pulse does not error', errors.length === 0, errors.join(' | '));

  await page.click('#btn-audio');
  await page.waitForTimeout(400);
  check('audio toggles on', await page.evaluate(() => window.hypercity.getState().audioEnabled));
  await page.click('#btn-audio');
  await page.waitForTimeout(200);

  await page.evaluate(() => window.hypercity.setCameraPreset('core'));
  await page.waitForTimeout(6000);
  await page.screenshot({ path: path.resolve('docs/final-core.png') });

  await page.click('#btn-help');
  await page.waitForTimeout(500);
  check('help opens', await page.locator('#help-overlay').evaluate((el) => el.classList.contains('is-open')));
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  check('escape closes help', await page.evaluate(() => !document.querySelector('#help-overlay')?.classList.contains('is-open')));

  await page.click('#btn-tour');
  await page.waitForTimeout(4000);
  check('tour mode starts', await page.evaluate(() => window.hypercity.getState().cameraMode === 'tour'));
  check(
    'tour letterbox becomes visible',
    await page.evaluate(() => document.body.classList.contains('tour-mode') && getComputedStyle(document.querySelector('.tour-frame')).opacity !== '0'),
  );
  await page.screenshot({ path: path.resolve('docs/final-tour.png') });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);
  check('escape exits tour', await page.evaluate(() => window.hypercity.getState().cameraMode === 'fly'));

  await page.keyboard.press('f');
  await page.waitForTimeout(300);
  check('photo mode enters with F', await page.evaluate(() => window.hypercity.getState().photoMode));
  await page.keyboard.press('f');
  await page.waitForTimeout(300);
  check('photo mode exits with F', await page.evaluate(() => !window.hypercity.getState().photoMode));

  await page.evaluate(() => {
    const app = window.hypercityApp;
    app.camera.position.set(28, 3, 164);
    app.camera.lookAt(28, 14, 0);
    app.controller.syncAnglesFromCamera();
    window.hypercity.setCameraMode('walk');
  });
  await page.waitForTimeout(600);
  const beforeWalk = await page.evaluate(() => window.hypercity.getMetrics().cameraPosition);
  await page.keyboard.down('w');
  await page.waitForTimeout(3800);
  await page.keyboard.up('w');
  await page.waitForTimeout(300);
  const afterWalk = await page.evaluate(() => window.hypercity.getMetrics().cameraPosition);
  const walked = Math.hypot(afterWalk.x - beforeWalk.x, afterWalk.z - beforeWalk.z);
  check('walk mode keyboard movement works', walked > 0.4, walked.toFixed(2));
  await page.screenshot({ path: path.resolve('docs/final-street.png') });

  await page.evaluate(() => window.hypercity.setCameraMode('fly'));
  await page.waitForTimeout(300);
  await page.evaluate(() => window.hypercity.startTour());
  await page.waitForTimeout(700);
  await page.evaluate(() => window.hypercity.stopTour());
  await page.waitForTimeout(300);
  check('API tour start/stop works', await page.evaluate(() => window.hypercity.getState().cameraMode === 'fly'));

  await page.evaluate(() => {
    window.hypercity.setTime(21.3);
    window.hypercity.setWeather('storm');
    window.hypercity.forceLightning();
  });
  await page.waitForTimeout(1800);
  await page.screenshot({ path: path.resolve('docs/final-storm.png') });
  check('weather API sets storm', await page.evaluate(() => window.hypercity.getState().weather === 'storm'));
  check('no page errors across interactions', errors.length === 0, errors.join(' | '));

  console.log(`RESULT ${checks.filter((item) => item.pass).length}/${checks.length} checks passed`);
  if (checks.some((item) => !item.pass) || errors.length) process.exitCode = 1;
} catch (error) {
  console.error(error);
  process.exitCode = 1;
  await page.screenshot({ path: path.resolve('docs/interaction-failure.png') }).catch(() => undefined);
} finally {
  await browser.close();
}
