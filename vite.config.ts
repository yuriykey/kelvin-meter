import { execSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { Plugin, ResolvedConfig } from 'vite';
// vitest/config re-exports Vite's defineConfig with the `test` block typed,
// so build config and test config stay in one file.
import { defineConfig } from 'vitest/config';

const packageJson = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

function gitSha(): string {
  try {
    return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    return 'nogit';
  }
}

const BUILD_TIME = new Date().toISOString();
const GIT_SHA = gitSha();
const APP_VERSION = packageJson.version as string;
/** Bumped on every build, so a new deploy always invalidates the old cache. */
const CACHE_VERSION = `${APP_VERSION}-${GIT_SHA}-${BUILD_TIME.replace(/[^0-9]/g, '').slice(0, 14)}`;

/** Files that must never be precached. */
const PRECACHE_EXCLUDE = new Set(['sw.js', '.DS_Store']);

function listFiles(root: string, directory = root): string[] {
  const out: string[] = [];
  for (const name of readdirSync(directory)) {
    const full = join(directory, name);
    if (statSync(full).isDirectory()) {
      out.push(...listFiles(root, full));
    } else {
      out.push(relative(root, full).split(/[\\/]/).join('/'));
    }
  }
  return out;
}

/**
 * Emits the service worker after the bundle is on disk.
 *
 * Reading the output directory rather than the Rollup bundle is deliberate:
 * it picks up everything Vite copied from `public/` (the manifest, the icons)
 * as well as the hashed JS and CSS, so nothing that the app needs offline is
 * left out of the precache by accident.
 */
function serviceWorkerPlugin(): Plugin {
  let config: ResolvedConfig;

  return {
    name: 'kelvinmeter:service-worker',
    apply: 'build',
    configResolved(resolved) {
      config = resolved;
    },
    closeBundle() {
      const outDir = join(config.root, config.build.outDir);
      const files = listFiles(outDir)
        .filter((file) => !PRECACHE_EXCLUDE.has(file))
        .filter((file) => !file.endsWith('.map'))
        .sort();

      // Relative URLs, resolved against the worker's own location at runtime.
      // This is what makes the app work unchanged at a GitHub Pages subpath
      // and at a domain root.
      const precache = files.map((file) => `./${file}`);

      const template = readFileSync(join(config.root, 'src/pwa/sw-template.js'), 'utf8');
      const source = template
        .replace('__CACHE_VERSION__', JSON.stringify(CACHE_VERSION))
        .replace('__PRECACHE_MANIFEST__', JSON.stringify(precache, null, 2));

      writeFileSync(join(outDir, 'sw.js'), source);
      this.info?.(`service worker precaching ${precache.length} files`);
    },
  };
}

export default defineConfig({
  // Relative so the built site works at https://user.github.io/repo/ without
  // knowing the repository name at build time.
  base: './',
  define: {
    __APP_VERSION__: JSON.stringify(APP_VERSION),
    __BUILD_TIME__: JSON.stringify(BUILD_TIME),
    __GIT_SHA__: JSON.stringify(GIT_SHA),
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
    assetsDir: 'assets',
    sourcemap: false,
    // One JS file keeps the offline precache simple and the cold start fast.
    rollupOptions: {
      output: {
        manualChunks: undefined,
      },
    },
  },
  plugins: [serviceWorkerPlugin()],
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
