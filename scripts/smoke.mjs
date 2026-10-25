import { chromium } from 'playwright-core';
import fs from 'node:fs/promises';
import path from 'node:path';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const BASE = process.env.HYPERCITY_URL ?? 'http://127.0.0.1:5173/';

const scenarios = [
  { name: 'intro', query: 'time=19.25&weather=clear&timeScale=0&quality=high&autoWeather=0', wait: 1700 },
  { name: 'default', query: 'skipIntro=1&time=19.25&weather=clear&timeScale=0&quality=high&autoWeather=0', wait: 1500 },
  { name: 'noon', query: 'skipIntro=1&time=12.5&weather=clear&timeScale=0&quality=high&autoWeather=0', wait: 1300 },
  { name: 'night-rain', query: 'skipIntro=1&time=22.6&weather=rain&timeScale=0&quality=high&autoWeather=0', wait: 2400 },
  { name: 'storm', query: 'skipIntro=1&time=21.2&weather=storm&timeScale=0&quality=high&autoWeather=0&lightning=1', wait: 5000 },
  { name: 'snow', query: 'skipIntro=1&time=9.1&weather=snow&timeScale=0&quality=high&autoWeather=0', wait: 2200 },
  { name: 'fog', query: 'skipIntro=1&time=7.2&weather=fog&timeScale=0&quality=high&autoWeather=0', wait: 2200 },
  { name: 'street', query: 'skipIntro=1&time=21.4&weather=rain&timeScale=0&quality=high&autoWeather=0&mode=walk', wait: 2500 },
  { name: 'day-street', query: 'skipIntro=1&time=13.4&weather=clear&timeScale=0&quality=high&autoWeather=0&mode=walk', wait: 1800 },
  {
    name: 'mobile',
    query: 'skipIntro=1&time=21.4&weather=rain&timeScale=0&quality=low&autoWeather=0&mode=walk',
    wait: 2000,
    viewport: { width: 390, height: 844 },
    hasTouch: true,
  },
  {
    name: 'mobile-controls',
    query: 'skipIntro=1&time=22.2&weather=storm&timeScale=0&quality=low&autoWeather=0',
    wait: 2200,
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    click: '#btn-mobile-controls',
  },
];

const only = process.argv[2]?.split(',');
const selected = only ? scenarios.filter((scenario) => only.includes(scenario.name)) : scenarios;
await fs.mkdir(path.resolve('docs'), { recursive: true });

const browser = await chromium.launch({
  executablePath: EDGE,
  headless: true,
  args: [
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--disable-gpu-sandbox',
    '--hide-scrollbars',
  ],
});

let failed = false;
for (const scenario of selected) {
  const page = await browser.newPage({
    viewport: scenario.viewport ?? { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    hasTouch: scenario.hasTouch ?? false,
  });
  const errors = [];
  const warnings = [];
  page.on('pageerror', (error) => errors.push(`PAGEERROR ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`CONSOLE ${message.text()}`);
    if (message.type() === 'warning') warnings.push(message.text());
  });
  const url = `${BASE}?${scenario.query}`;
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForFunction(() => Boolean(window.hypercity), null, { timeout: 60_000 });
    await page.evaluate(() => window.hypercity.ready);
    await page.waitForTimeout(scenario.wait);
    if (scenario.click) await page.click(scenario.click);
    if (scenario.click) await page.waitForTimeout(400);
    const screenshotPath = path.resolve('docs', `${scenario.name}.png`);
    await page.screenshot({ path: screenshotPath });
    const metrics = await page.evaluate(() => window.hypercity.getMetrics());
    const state = await page.evaluate(() => window.hypercity.getState());
    console.log(`SCENARIO ${scenario.name}`);
    console.log(`  screenshot ${screenshotPath}`);
    console.log(`  metrics ${JSON.stringify(metrics)}`);
    console.log(`  state ${JSON.stringify({ weather: state.weather, cameraMode: state.cameraMode, time: Number(state.timeHours.toFixed(2)) })}`);
    if (errors.length) {
      failed = true;
      console.log(`  errors ${JSON.stringify(errors, null, 2)}`);
    } else {
      console.log('  errors none');
    }
    if (warnings.length) console.log(`  warnings ${JSON.stringify(warnings.slice(0, 5), null, 2)}`);
  } catch (error) {
    failed = true;
    console.log(`SCENARIO ${scenario.name} FAILED`);
    console.log(error);
    if (errors.length) console.log(JSON.stringify(errors, null, 2));
    try {
      await page.screenshot({ path: path.resolve('docs', `${scenario.name}-failure.png`) });
    } catch {
      // Ignore screenshot failures after navigation errors.
    }
  }
  await page.close();
}

await browser.close();
if (failed) process.exitCode = 1;
