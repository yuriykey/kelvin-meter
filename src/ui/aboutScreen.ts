/**
 * Guide screen: how to shoot the file, what each mode is actually worth, and
 * a dump of what this browser really exposes.
 *
 * The capability report is not a debugging leftover. What live mode can do
 * depends entirely on the device, and the honest answer to "why can't it just
 * lock white balance" is the list of constraints this browser does not
 * implement — so the app shows it rather than asserting it.
 */

import { APP_VERSION, BUILD_TIME, GIT_SHA } from '../version.ts';
import { formatCapabilityReport } from '../live/index.ts';
import { isStandalone } from '../pwa/register.ts';
import type { App, AppState } from './app.ts';
import type { LiveController } from './liveController.ts';
import { badge, card, sectionHeader } from './components.ts';
import { button, copyText, el } from './dom.ts';

type Actions = App['actions'];

export function renderAboutScreen(
  state: AppState,
  actions: Actions,
  live: LiveController,
): HTMLElement {
  const screen = el('div', { class: 'screen' });

  screen.appendChild(sectionHeader('Guide', 'How to get a number you can act on'));

  screen.appendChild(
    card(
      'Which mode to trust',
      el(
        'div',
        { class: 'prose' },
        el('h3', {}, 'Import RAW — the accurate one'),
        el(
          'p',
          {},
          'A DNG carries the camera’s own illuminant estimate in unprocessed camera space. That is the measurement. Typical agreement with a reference is around ±150 K once calibrated, and it is highly repeatable shot to shot.',
        ),
        el('h3', {}, 'Live — approximate'),
        el(
          'p',
          {},
          'iOS gives no way to turn auto white balance off, so every frame arrives with the colour cast already removed. Live mode recovers what is left from ratios between reference patches. Expect ±400 K at best, worse in mixed lighting. Use it to choose between "warm" and "cool", not to set a final white balance.',
        ),
      ),
    ),
  );

  screen.appendChild(
    card(
      'Shooting the DNG',
      el(
        'div',
        { class: 'prose' },
        el('ul', {},
          el('li', {}, el('strong', {}, 'iPhone Pro: '), 'turn on Apple ProRAW in Settings → Camera → Formats, then tap RAW in the Camera app.'),
          el('li', {}, el('strong', {}, 'Any iPhone: '), 'Adobe Lightroom mobile’s built-in camera shoots DNG for free. Halide works too.'),
          el('li', {}, el('strong', {}, 'Nikon NEF: '), 'also TIFF-based and carries the same white balance metadata, but it is not tested here and is not supported in this version.'),
        ),
        el(
          'p',
          {},
          'Fill a good part of the frame with the light you are measuring, and keep other sources out of shot. The camera is estimating one illuminant for the whole scene; a mixed frame gives you an average of the mixture.',
        ),
        el(
          'p',
          {},
          'A HEIC or JPEG cannot work, no matter how it was shot. The processing that made it has already removed the thing being measured.',
        ),
      ),
    ),
  );

  screen.appendChild(
    card(
      'Transferring the number',
      el(
        'div',
        { class: 'prose' },
        el(
          'p',
          {},
          'The Kelvin and tint values follow Adobe’s scale, the one Lightroom, Camera Raw, DxO PhotoLab and Affinity Photo put on their white balance sliders. Type them straight in.',
        ),
        el(
          'p',
          {},
          'Duv is shown as well because it is the physically meaningful quantity: it is the signed distance from the blackbody locus, positive towards green. Two lights at the same Kelvin with different Duv look different, and no temperature slider alone will match them.',
        ),
      ),
    ),
  );

  screen.appendChild(renderCapabilities(actions, live));
  screen.appendChild(renderAbout(state));

  return screen;
}

function renderCapabilities(actions: Actions, live: LiveController): HTMLElement {
  const report = live.capabilityReport();
  const text = formatCapabilityReport(report);

  const missing = report.missingForMeasurement;
  const hasTrack = report.trackCapabilities !== null;

  const badges = el('div', { class: 'readout__badges', style: 'justify-content:flex-start' });
  if (hasTrack && missing.length === 0) {
    badges.appendChild(badge('Camera controls available', 'ok'));
  } else {
    for (const name of missing) badges.appendChild(badge(`no ${name}`, 'danger'));
  }

  return card(
    'What this browser actually exposes',
    el(
      'p',
      { class: 'card__note', style: 'margin-top:0' },
      hasTrack
        ? live.currentStream
          ? 'Captured from the live camera track on this device.'
          : `Captured from the camera track at ${new Date(report.capturedAt).toLocaleTimeString()}. The camera is released when this screen is open.`
        : 'Open live mode once, then come back, to include the camera track’s own capabilities.',
    ),
    badges,
    el('pre', { class: 'code-block' }, text),
    el(
      'div',
      { class: 'btn-row' },
      button('Copy report', 'btn', () => {
        void copyText(text).then((ok) =>
          actions.toast(ok ? 'Capability report copied.' : 'Copy was blocked by the browser.'),
        );
      }),
      button('Refresh', 'btn', () => actions.refresh()),
    ),
    el(
      'p',
      { class: 'card__note' },
      'If whiteBalanceMode and exposureMode are absent above, no web app on this device can lock the camera — including this one. That is why RAW import exists.',
    ),
  );
}

function renderAbout(state: AppState): HTMLElement {
  return card(
    'About',
    el(
      'dl',
      { class: 'detail-list' },
      el('dt', {}, 'Version'),
      el('dd', {}, APP_VERSION),
      el('dt', {}, 'Commit'),
      el('dd', {}, GIT_SHA),
      el('dt', {}, 'Built'),
      el('dd', {}, new Date(BUILD_TIME).toLocaleString()),
      el('dt', {}, 'Installed'),
      el('dd', {}, isStandalone() ? 'Home screen' : 'Browser tab'),
      el('dt', {}, 'Saved readings'),
      el('dd', {}, String(state.measurements.length)),
      el('dt', {}, 'Profiles'),
      el('dd', {}, String(state.profiles.length)),
    ),
    el(
      'p',
      { class: 'card__note' },
      'Everything runs on this device. No network requests are made after the app is installed, and no measurement, file or image ever leaves the phone.',
    ),
  );
}
