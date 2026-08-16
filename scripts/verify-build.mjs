#!/usr/bin/env node
/**
 * Post-build checks on dist/.
 *
 * The failure this guards against is specific and nasty: a PWA whose service
 * worker precaches a file that is not there installs nothing at all
 * (`cache.addAll` is atomic), so the app looks fine online and is simply
 * missing offline — which is the one thing it is supposed to be. That is not
 * something a unit test can see, so it is checked against the real output.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');

const failures = [];

function fail(message) {
  failures.push(message);
}

function listFiles(directory, base = directory) {
  const out = [];
  for (const name of readdirSync(directory)) {
    const full = join(directory, name);
    if (statSync(full).isDirectory()) out.push(...listFiles(full, base));
    else out.push(relative(base, full).split(/[\\/]/).join('/'));
  }
  return out;
}

if (!existsSync(dist)) {
  console.error('dist/ does not exist. Run the build first.');
  process.exit(1);
}

const files = new Set(listFiles(dist));

/* --- everything the app needs must exist ------------------------------- */

for (const required of [
  'index.html',
  'sw.js',
  'manifest.webmanifest',
  'apple-touch-icon.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-192.png',
  'icons/icon-maskable-512.png',
]) {
  if (!files.has(required)) fail(`missing from dist: ${required}`);
}

/* --- the precache manifest must match what was actually built ---------- */

const sw = readFileSync(join(dist, 'sw.js'), 'utf8');

if (sw.includes('__PRECACHE_MANIFEST__') || sw.includes('__CACHE_VERSION__')) {
  fail('service worker still contains build placeholders');
}

const manifestMatch = sw.match(/const PRECACHE = (\[[\s\S]*?\]);/);
if (!manifestMatch) {
  fail('could not find the precache manifest in sw.js');
} else {
  const precache = JSON.parse(manifestMatch[1]);
  if (precache.length === 0) fail('precache manifest is empty');

  for (const entry of precache) {
    if (!entry.startsWith('./')) {
      fail(`precache entry is not relative, so it will 404 at a subpath: ${entry}`);
    }
    const path = entry.slice(2);
    if (!files.has(path)) {
      fail(`precache lists a file that was not built: ${entry}`);
    }
  }

  // The shell and the hashed bundles are what make an offline launch work.
  for (const needed of ['./index.html', './manifest.webmanifest']) {
    if (!precache.includes(needed)) fail(`precache is missing ${needed}`);
  }
  const hasJs = precache.some((entry) => entry.endsWith('.js'));
  const hasCss = precache.some((entry) => entry.endsWith('.css'));
  if (!hasJs) fail('precache contains no JavaScript bundle');
  if (!hasCss) fail('precache contains no stylesheet');
}

/* --- nothing may reference an absolute path ---------------------------- */

const html = readFileSync(join(dist, 'index.html'), 'utf8');
const absoluteRefs = [...html.matchAll(/(?:src|href)="(\/[^/][^"]*)"/g)].map((m) => m[1]);
if (absoluteRefs.length > 0) {
  fail(
    `index.html references absolute paths, which break at a GitHub Pages subpath: ${absoluteRefs.join(', ')}`,
  );
}

const manifest = JSON.parse(readFileSync(join(dist, 'manifest.webmanifest'), 'utf8'));
for (const [key, value] of [
  ['start_url', manifest.start_url],
  ['scope', manifest.scope],
]) {
  if (typeof value === 'string' && value.startsWith('/')) {
    fail(`manifest ${key} is absolute (${value}); it must be relative for a subpath deploy`);
  }
}
for (const icon of manifest.icons ?? []) {
  if (icon.src.startsWith('/')) fail(`manifest icon is absolute: ${icon.src}`);
  const path = icon.src.replace(/^\.\//, '');
  if (!files.has(path)) fail(`manifest references a missing icon: ${icon.src}`);
}

/* --- report ------------------------------------------------------------ */

if (failures.length > 0) {
  console.error('Build verification failed:');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log(`Build verified: ${files.size} files, precache complete, all paths relative.`);
