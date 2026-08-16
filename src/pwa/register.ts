/**
 * Service worker registration and update handling.
 *
 * The scope is derived from the document's own location rather than hard
 * coded. The app is served from a GitHub Pages subpath in production and from
 * the root in development, and a registration whose scope does not match the
 * subpath silently controls nothing.
 */

export type UpdateListener = (apply: () => void) => void;

export interface PwaStatus {
  readonly supported: boolean;
  readonly registered: boolean;
  readonly scope: string | null;
  readonly error: string | null;
}

let waitingWorker: ServiceWorker | null = null;

/** Directory the app is served from, with a trailing slash. */
export function appBaseUrl(): string {
  return new URL('./', document.baseURI).href;
}

export async function registerServiceWorker(onUpdate: UpdateListener): Promise<PwaStatus> {
  if (!('serviceWorker' in navigator)) {
    return { supported: false, registered: false, scope: null, error: null };
  }
  // The dev server serves modules unbundled and there is no generated worker,
  // so registering would 404.
  if (import.meta.env.DEV) {
    return { supported: true, registered: false, scope: null, error: 'disabled in dev' };
  }

  const base = appBaseUrl();

  try {
    const registration = await navigator.serviceWorker.register(new URL('sw.js', base), {
      scope: base,
    });

    // A worker already waiting means a previous visit downloaded an update
    // that has not been applied yet.
    if (registration.waiting && navigator.serviceWorker.controller) {
      waitingWorker = registration.waiting;
      onUpdate(applyUpdate);
    }

    registration.addEventListener('updatefound', () => {
      const installing = registration.installing;
      if (!installing) return;
      installing.addEventListener('statechange', () => {
        if (installing.state === 'installed' && navigator.serviceWorker.controller) {
          waitingWorker = installing;
          onUpdate(applyUpdate);
        }
      });
    });

    // Reload once the new worker takes over, so the page and the cache agree.
    let reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (reloading) return;
      reloading = true;
      window.location.reload();
    });

    // Check for a new build on every launch. Without this a phone can sit on
    // a cached build indefinitely.
    void registration.update().catch(() => {
      /* offline: the cached build is exactly what we want anyway */
    });

    return { supported: true, registered: true, scope: registration.scope, error: null };
  } catch (error) {
    return {
      supported: true,
      registered: false,
      scope: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function applyUpdate(): void {
  if (!waitingWorker) {
    window.location.reload();
    return;
  }
  waitingWorker.postMessage({ type: 'SKIP_WAITING' });
}

/** True when running from the home screen rather than in a browser tab. */
export function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  const iosStandalone = (window.navigator as { standalone?: boolean }).standalone === true;
  return iosStandalone || window.matchMedia('(display-mode: standalone)').matches;
}
