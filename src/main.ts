/**
 * Entry point.
 */

import './ui/styles.css';
import { App } from './ui/app.ts';
import { registerServiceWorker } from './pwa/register.ts';

const root = document.getElementById('app');
if (!root) throw new Error('#app is missing from the document');

const app = new App(root);

void app.init().then(() => {
  void registerServiceWorker((apply) => app.actions.setUpdateAvailable(apply));
});

// Release the camera when the app goes to the background. iOS suspends the
// page anyway, but this drops the recording indicator promptly and means the
// stream is not left half-alive when the app comes back.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' && app.live.active) {
    app.live.stop();
    app.render();
  }
});

window.addEventListener('pagehide', () => app.live.dispose());
