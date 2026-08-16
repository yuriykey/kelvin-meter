/**
 * Build identity, injected by Vite at build time.
 *
 * A version string that is visible in the UI is not decoration here. A stale
 * service worker pinning an old build on a phone is the classic PWA failure,
 * and when someone reports a wrong reading the first question is which build
 * they are actually running.
 */

declare const __APP_VERSION__: string;
declare const __BUILD_TIME__: string;
declare const __GIT_SHA__: string;

export const APP_VERSION: string =
  typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '0.0.0-dev';

export const BUILD_TIME: string =
  typeof __BUILD_TIME__ === 'string' ? __BUILD_TIME__ : new Date().toISOString();

export const GIT_SHA: string = typeof __GIT_SHA__ === 'string' ? __GIT_SHA__ : 'dev';

/** Short form for the corner of the screen. */
export const VERSION_LABEL = `v${APP_VERSION} · ${GIT_SHA}`;
