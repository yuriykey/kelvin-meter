#!/usr/bin/env node
/**
 * End-to-end smoke test against the production build.
 *
 * This exists mainly for one check that nothing else can make: that the app
 * actually works offline, served from a subpath, the way it will be on GitHub
 * Pages. Unit tests cannot see a service worker whose precache 404s, and that
 * failure is invisible online and total offline.
 *
 * It also walks the main flows — import a DNG, reject a bad file, save to the
 * log, build a two-point calibration, run live mode against a fake camera —
 * because those cross the DOM boundary the unit tests deliberately stay behind.
 *
 * Deliberately NOT part of CI: it needs a browser binary. Run it locally with
 *
 *     npm run build && npm run smoke
 */

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(root, 'dist');
const FIXTURES = join(root, 'test', 'fixtures');

/** Served from a subpath on purpose: that is where PWAs on Pages break. */
const BASE = '/kelvin-meter/';
const PORT = 5599;
const URL_BASE = `http://localhost:${PORT}${BASE}`;

if (!existsSync(DIST)) {
  console.error('dist/ does not exist. Run `npm run build` first.');
  process.exit(1);
}

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.error('Playwright is not installed. Run `npm install` first.');
  process.exit(1);
}

/* ---------------------------------------------------------------- server */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
  '.json': 'application/json',
};

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', 'http://localhost');
  if (!url.pathname.startsWith(BASE)) {
    response.writeHead(404).end('outside base path');
    return;
  }
  let relative = url.pathname.slice(BASE.length);
  if (relative === '' || relative.endsWith('/')) relative += 'index.html';
  const file = join(DIST, relative);
  try {
    if (!(await stat(file)).isFile()) throw new Error('not a file');
    response.writeHead(200, {
      'Content-Type': MIME[extname(file)] ?? 'application/octet-stream',
      'Service-Worker-Allowed': BASE,
    });
    response.end(await readFile(file));
  } catch {
    response.writeHead(404).end('not found');
  }
});

await new Promise((resolve) => server.listen(PORT, resolve));

/* --------------------------------------------------------------- harness */

const failures = [];
let checks = 0;

function check(label, condition, detail = '') {
  checks++;
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
    failures.push(label);
  }
}

function findBrowser() {
  const explicit = process.env.CHROMIUM_PATH;
  if (explicit) return explicit;
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (!base) return undefined;
  for (const name of ['chromium', 'chromium-1194']) {
    const candidate = join(base, name, 'chrome-linux', 'chrome');
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

const browser = await chromium.launch({
  executablePath: findBrowser(),
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
});
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  permissions: ['camera'],
});
const page = await context.newPage();

const consoleErrors = [];
page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`));
page.on('console', (message) => {
  if (message.type() === 'error') consoleErrors.push(`console: ${message.text()}`);
});

const fixture = (name) => join(FIXTURES, name);
const pause = (ms) => page.waitForTimeout(ms);

try {
  /* ------------------------------------------------------------- boot */
  console.log('\nShell');
  await page.goto(URL_BASE, { waitUntil: 'networkidle' });
  await pause(800);

  check('page loads', (await page.title()) === 'KelvinMeter');
  check('all four screens present', (await page.locator('.tabbar button').count()) === 4);

  const registration = await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.getRegistration();
    return reg ? { scope: reg.scope, active: Boolean(reg.active) } : null;
  });
  check('service worker registered', registration !== null);
  check(
    'service worker scope matches the subpath',
    registration?.scope === URL_BASE,
    `got ${registration?.scope}`,
  );
  check('service worker is active', registration?.active === true);

  /* -------------------------------------------------------- raw import */
  console.log('\nRAW import');
  const filePicker = () => page.locator('input[type=file]').first();

  await filePicker().setInputFiles(fixture('synthetic-le.dng'));
  await pause(500);
  const kelvin = await page.locator('.readout__kelvin').textContent();
  check('reads a temperature from a DNG', /^\d{4}K$/.test(kelvin ?? ''), `got ${kelvin}`);

  const details = await page.locator('.detail-list').first().innerText();
  check('shows the source tag', details.includes('AsShotNeutral'));
  check('names both calibration illuminants', details.includes('Standard light A'));
  check('reports the solve pass count', /Solve passes\s*\n?\s*\d/.test(details));

  await filePicker().setInputFiles(fixture('not-a-dng.bin'));
  await pause(400);
  check(
    'rejects a non-DNG with a warning that replaces the number',
    (await page.locator('.readout__warning').textContent()) === 'UNSUPPORTED FILE',
  );
  check('hides the number while warning', (await page.locator('.readout__kelvin').count()) === 0);

  /* --------------------------------------------------------------- log */
  console.log('\nShoot log');
  await filePicker().setInputFiles(fixture('synthetic-le.dng'));
  await pause(400);
  await page.getByRole('button', { name: 'Save…' }).click();
  await pause(250);
  await page.locator('#save-form input').first().fill('Kitchen');
  await page.locator('#save-form').getByRole('button', { name: 'Save', exact: true }).click();
  await pause(600);

  await page.getByRole('button', { name: 'Log' }).click();
  await pause(400);
  check(
    'saved reading appears in the log',
    (await page.locator('.measurement__label').allTextContents()).includes('Kitchen'),
  );

  /* ------------------------------------------------------- calibration */
  console.log('\nCalibration');
  await page.getByRole('button', { name: 'Calibrate' }).click();
  await pause(300);
  await page.locator('input[placeholder*="ProRAW"]').fill('ProRAW / smoke test');
  await page.getByRole('button', { name: 'Create profile' }).click();
  await pause(500);

  async function storePoint(file, referenceKelvin) {
    await page.getByRole('button', { name: 'Measure' }).click();
    await pause(250);
    await filePicker().setInputFiles(fixture(file));
    await pause(400);
    await page.getByRole('button', { name: 'Calibrate' }).click();
    await pause(300);
    await page.locator('input[placeholder="Known CCT in Kelvin"]').fill(String(referenceKelvin));
    await page.getByRole('button', { name: 'Store point' }).click();
    await pause(500);
  }

  await storePoint('synthetic-warm.dng', 2700);
  check('one point does not draw a fit', (await page.locator('svg.plot').count()) === 0);

  await storePoint('synthetic-cool.dng', 6000);
  check('two points draw a fit', (await page.locator('svg.plot').count()) === 1);
  check('both points listed', (await page.locator('.point-row').count()) === 2);
  check(
    'a two-point fit reproduces both points exactly',
    (await page.locator('.point-row__residual').allTextContents()).every(
      (text) => text === '+0 K',
    ),
  );

  await page.getByRole('button', { name: 'Measure' }).click();
  await pause(250);
  await filePicker().setInputFiles(fixture('synthetic-le.dng'));
  await pause(500);
  const badges = await page.locator('.readout__badges .badge').allTextContents();
  check(
    'reading is marked calibrated and names the profile',
    badges.some((text) => text.startsWith('Calibrated · ProRAW / smoke test')),
    badges.join(' | '),
  );

  /* --------------------------------------------------------- live mode */
  console.log('\nLive mode');
  await page.getByRole('button', { name: 'Live (approx)' }).click();
  await pause(2500);

  check('viewfinder is shown', (await page.locator('.viewfinder').count()) === 1);
  check('four guide boxes', (await page.locator('.guide').count()) === 4);
  check(
    'guide boxes are labelled with the patch to find on the card',
    (await page.locator('.guide__label').allTextContents()).join(',') ===
      'Orange,Cyan,Green,Grey',
  );
  check(
    'guide boxes are numbered to match the legend',
    (await page.locator('.guide__index').allTextContents()).join(',') === '1,2,3,4',
  );
  check(
    'the squares are explained before they are shown',
    (await page.locator('.card__title').allTextContents()).includes('What are the squares?'),
  );

  const video = await page.evaluate(() => {
    const node = document.querySelector('.viewfinder video');
    return node ? { width: node.videoWidth, paused: node.paused } : null;
  });
  check('camera stream is playing', (video?.width ?? 0) > 0 && video?.paused === false);

  // With no card and no profile, the precondition has to win. Being told to
  // "angle the card away from the light" first is advice about a card this
  // user does not have, for a problem that is not the one stopping them.
  check(
    'an uncalibrated user is told what they actually need',
    (await page.locator('.readout__warning').textContent()) === 'NO CALIBRATION',
  );
  const liveWarning = (await page.locator('.readout__warning-detail').textContent()) ?? '';
  check(
    'the warning names the card and points at the mode that works',
    /colour checker card/i.test(liveWarning) && /IMPORT RAW/.test(liveWarning),
    liveWarning,
  );
  check(
    'there is a way back to IMPORT RAW without hunting for it',
    (await page.getByRole('button', { name: 'Use IMPORT RAW instead' }).count()) === 1,
  );

  /* ------------------------------------------------------ guide screen */
  console.log('\nGuide');
  await page.getByRole('button', { name: 'Guide' }).click();
  await pause(600);

  const report = JSON.parse((await page.locator('.code-block').textContent()) ?? '{}');
  check(
    'capability report survives the camera being released',
    report.trackCapabilities !== null && report.trackSettings !== null,
  );
  check('capability report names the device', typeof report.deviceLabel === 'string');
  check(
    'camera is released when leaving the measure screen',
    await page.evaluate(() => {
      const node = document.querySelector('video');
      return node === null || node.srcObject === null;
    }),
  );

  /* ----------------------------------------------------------- offline */
  console.log('\nOffline');
  await context.setOffline(true);
  await page.goto(URL_BASE, { waitUntil: 'domcontentloaded' });
  await pause(1200);

  check('app loads with no network', (await page.title()) === 'KelvinMeter');
  check('UI is rendered offline', (await page.locator('.tabbar button').count()) === 4);

  await page.getByRole('button', { name: 'Log' }).click();
  await pause(400);
  check(
    'saved data survives an offline reload',
    (await page.locator('.measurement__label').allTextContents()).includes('Kitchen'),
  );

  await context.setOffline(false);

  console.log('\nConsole');
  check('no uncaught errors or console errors', consoleErrors.length === 0, consoleErrors.join('; '));
} finally {
  await browser.close();
  server.close();
}

console.log(
  `\n${checks - failures.length}/${checks} checks passed` +
    (failures.length ? `\nFailed: ${failures.join(', ')}` : ''),
);
process.exit(failures.length > 0 ? 1 : 0);
