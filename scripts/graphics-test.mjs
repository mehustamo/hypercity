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
page.on('pageerror', (error) => errors.push(error.message));
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(message.text());
});
const checks = [];
function check(name, condition, detail = '') {
  checks.push(Boolean(condition));
  console.log(`${condition ? 'PASS' : 'FAIL'} ${name}${detail ? ` :: ${detail}` : ''}`);
}

try {
  await page.goto(`${BASE}?skipIntro=1&time=19.25&weather=clear&timeScale=0&quality=high&autoWeather=0`, {
    waitUntil: 'domcontentloaded',
  });
  await page.waitForFunction(() => Boolean(window.hypercity));
  await page.evaluate(() => window.hypercity.ready);
  await page.waitForTimeout(1200);

  await page.click('#btn-graphics');
  await page.waitForTimeout(500);
  check('graphics panel opens', await page.locator('#graphics-panel').evaluate((el) => el.classList.contains('is-open')));
  await page.screenshot({ path: path.resolve('docs/graphics-panel.png') });

  await page.click('#btn-bloom');
  await page.waitForTimeout(400);
  check('bloom toggles off', await page.evaluate(() => window.hypercity.getState().bloomEnabled === false));
  await page.screenshot({ path: path.resolve('docs/graphics-bloom-off.png') });

  await page.click('#btn-shadows');
  await page.waitForTimeout(400);
  check('shadows toggle off', await page.evaluate(() => window.hypercity.getState().shadowsEnabled === false));

  await page.click('#quality-low');
  await page.waitForTimeout(500);
  check('render scale switches to low', await page.evaluate(() => window.hypercity.getState().quality === 'low'));

  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  check('escape closes graphics panel', await page.evaluate(() => !document.querySelector('#graphics-panel')?.classList.contains('is-open')));

  await page.keyboard.press('g');
  await page.waitForTimeout(300);
  check('G opens graphics panel', await page.evaluate(() => document.querySelector('#graphics-panel')?.classList.contains('is-open')));
  await page.keyboard.press('g');

  await page.evaluate(() => {
    window.hypercity.setBloomEnabled(true);
    window.hypercity.setShadowsEnabled(true);
    window.hypercity.setQuality('auto');
  });
  await page.waitForTimeout(400);
  check(
    'graphics API restores defaults',
    await page.evaluate(() => {
      const state = window.hypercity.getState();
      return state.bloomEnabled && state.shadowsEnabled && state.quality === 'auto';
    }),
  );
  check('no page errors', errors.length === 0, errors.join(' | '));
  console.log(`RESULT ${checks.filter(Boolean).length}/${checks.length} checks passed`);
  if (checks.some((item) => !item) || errors.length) process.exitCode = 1;
} catch (error) {
  console.error(error);
  process.exitCode = 1;
  await page.screenshot({ path: path.resolve('docs/graphics-failure.png') }).catch(() => undefined);
} finally {
  await browser.close();
}
