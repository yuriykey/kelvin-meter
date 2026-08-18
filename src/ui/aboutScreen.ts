/**
 * Guide screen.
 *
 * Written for someone who has never heard of colour temperature and just
 * wants a number to type into their photo program. Short sentences, common
 * words, one idea at a time, and the steps in the order you actually do them.
 *
 * The technical readout the app still needs — the camera capability dump and
 * the build version — is kept, but folded away at the bottom so it is not the
 * first thing a beginner meets.
 */

import { APP_VERSION, BUILD_TIME, GIT_SHA } from '../version.ts';
import { formatCapabilityReport } from '../live/index.ts';
import { isStandalone } from '../pwa/register.ts';
import type { App, AppState } from './app.ts';
import type { LiveController } from './liveController.ts';
import { badge, card, sectionHeader } from './components.ts';
import { button, copyText, el } from './dom.ts';

type Actions = App['actions'];

/** A numbered list of steps. */
function steps(...items: (string | Node)[]): HTMLElement {
  return el('ol', { class: 'steps' }, ...items.map((item) => el('li', {}, item)));
}

function bullets(...items: (string | Node)[]): HTMLElement {
  return el('ul', { class: 'plain-list' }, ...items.map((item) => el('li', {}, item)));
}

function para(...content: (string | Node)[]): HTMLElement {
  return el('p', { class: 'guide-text' }, ...content);
}

function strong(text: string): HTMLElement {
  return el('strong', {}, text);
}

export function renderAboutScreen(
  state: AppState,
  actions: Actions,
  live: LiveController,
): HTMLElement {
  const screen = el('div', { class: 'screen' });

  screen.appendChild(sectionHeader('How to use this app', 'Start at the top'));

  screen.appendChild(
    card(
      'What this app is for',
      para(
        'Light has a colour. An old light bulb makes warm, orange light. Light from a window is cooler and more blue. Your eyes fix this on their own, so you never notice. Cameras do not.',
      ),
      para(
        'This app tells you the colour of the light as a number. You type that number into your photo program. Then the colours in your photo look right.',
      ),
      el(
        'p',
        { class: 'guide-note' },
        'Everything happens on this phone. Your photos and readings never leave it.',
      ),
    ),
  );

  screen.appendChild(
    card(
      'What you need',
      steps(
        'An iPhone.',
        el(
          'span',
          {},
          'A camera app that can take ',
          strong('RAW'),
          ' photos. These are also called ',
          strong('DNG'),
          ' files.',
        ),
      ),
      para('You get RAW photos in one of two ways:'),
      bullets(
        el(
          'span',
          {},
          strong('iPhone Pro: '),
          'Open Settings. Go to Camera, then Formats. Turn on Apple ProRAW. Now the Camera app has a RAW button. Tap it before you take the picture.',
        ),
        el(
          'span',
          {},
          strong('Any iPhone: '),
          'Get the free Adobe Lightroom app. Use the camera inside that app. It takes DNG photos for free.',
        ),
      ),
      el(
        'p',
        { class: 'guide-note' },
        'A normal photo will not work. Your phone already fixed the colour in a normal photo, so the light colour is gone. The app will tell you if you pick the wrong kind of photo.',
      ),
    ),
  );

  screen.appendChild(
    card(
      'How to measure a room',
      steps(
        'Turn on the light you want to measure. Turn off other lights if you can.',
        'Take a RAW photo of the room.',
        'Open this app. Check that the button at the top says IMPORT RAW.',
        'Tap “Choose a DNG”.',
        'Pick the photo you just took.',
        'Read the big number.',
      ),
      el('p', { class: 'guide-note' }, 'That is the whole thing. You are done.'),
    ),
  );

  screen.appendChild(
    card(
      'What the big number means',
      para('The big number is the colour of the light. It is measured in Kelvin, or K.'),
      para('A small number means warm orange light. A big number means cool blue light.'),
      kelvinScale(),
      para(
        'The smaller number under it is called tint. It says if the light leans a little green or a little pink. Most lights are close to zero.',
      ),
    ),
  );

  screen.appendChild(
    card(
      'Using the number in your photo program',
      para(
        'Open your photo in Lightroom, DxO PhotoLab, or Affinity Photo. Look for the white balance settings.',
      ),
      steps(
        'Type the big number into the box named Temp or Temperature.',
        'Type the smaller number into the box named Tint.',
      ),
      el('p', { class: 'guide-note' }, 'The numbers are made to match those boxes. Just type them in.'),
    ),
  );

  screen.appendChild(
    card(
      'Measuring more than one room',
      para('Rooms often have different light. You can keep a list.'),
      steps(
        'After you read a number, tap SAVE.',
        'Type the room name, like Kitchen. Tap Save.',
        'Do the same for each room.',
        'Tap the LOG button at the bottom to see your whole list.',
        'Tap “Copy as text” to send the list to yourself.',
      ),
    ),
  );

  screen.appendChild(
    card(
      'Do you need to calibrate?',
      el(
        'p',
        { class: 'guide-big-answer' },
        'No. You can use the app right now.',
      ),
      para(
        'Calibrating makes the numbers a little more exact. Most people do not need it. Skip it unless the numbers look wrong to you.',
      ),
    ),
  );

  screen.appendChild(
    card(
      'Best way: use a colour checker card',
      para(
        'If you own a colour checker card, this is the most accurate way to calibrate, and it beats a light bulb’s printed rating.',
      ),
      para(
        'The card does not tell you the colour of the light by itself. What it does is let your photo program work the colour out exactly. Then you tell this app that answer.',
      ),
      steps(
        'Stand the card up in the room, lit by the light you want to measure.',
        'Take a RAW photo with the card in the picture.',
        'Open that photo in your photo program.',
        'Find the white balance eyedropper tool. Click it on the second-lightest grey square on the card. Not the pure white one, and not a dark one.',
        'Your program now shows the correct Temp and Tint. Write both down.',
        'Open the same photo in this app on the MEASURE screen.',
        'Go to CALIBRATE, type in the Temp number you wrote down, and tap “Store point”.',
        'Do the whole thing again in a room with very different light. One warm room and one cool room works best.',
      ),
      el(
        'p',
        { class: 'guide-note' },
        'This makes the app agree with your photo program. That is exactly what you want, because your photo program is where the number gets typed in.',
      ),
    ),
  );

  screen.appendChild(
    card(
      'If you do want to calibrate',
      para(
        'No colour checker card? Then you need a light where you already know the correct number.',
      ),
      bullets(
        el(
          'span',
          {},
          strong('Good: '),
          'a photo light or LED panel with settings printed on it, like 3200K or 5600K. These are close to correct.',
        ),
        el(
          'span',
          {},
          strong('Okay: '),
          'a light bulb with the number printed on its box. These can be off by 150 or more. Not great, but better than nothing.',
        ),
      ),
      para('Then do this:'),
      steps(
        'Tap CALIBRATE at the bottom.',
        'Type a name, like “My iPhone”. Tap “Create profile”.',
        'Take a RAW photo of your known light. Open it on the MEASURE screen.',
        'Come back to CALIBRATE. Type the real number of that light. Tap “Store point”.',
        'Do it again with a second light. One warm light and one cool light works best.',
        'Tap “Export JSON” and save the file somewhere safe.',
      ),
      el(
        'p',
        { class: 'guide-note guide-note--warn' },
        'Do not skip the last step. iPhones sometimes delete app data on their own. If that happens, your calibration is gone unless you saved that file.',
      ),
    ),
  );

  screen.appendChild(
    card(
      'The LIVE button, and what the squares are',
      para(
        'There is a second mode called LIVE. It points the camera at the room and guesses, with no photo needed.',
      ),
      para(
        'When you tap it you see four squares on the screen. They are not measuring the room. They are aiming marks.',
      ),
      para(
        'They need a colour checker card. That is a printed card covered in small coloured squares, sold for checking colour in photos. You hold it in front of the camera and line each square on screen up with the colour named under it.',
      ),
      para(
        'The app then compares those colours to each other. That comparison is what tells it about the light.',
      ),
      el(
        'p',
        { class: 'guide-note guide-note--warn' },
        'No card means this mode cannot work at all, and the squares will never do anything. Tap IMPORT RAW instead. It is the accurate one anyway.',
      ),
      para('Even with a card, you must calibrate LIVE first, and it is only a rough guess.'),
    ),
  );

  screen.appendChild(
    card(
      'If you see red words',
      para('Red words mean the app is not sure, so it will not show a number. It tells you what to fix.'),
      bullets(
        el(
          'span',
          {},
          strong('UNSUPPORTED FILE: '),
          'that photo is not a RAW photo. Take a new one with RAW turned on.',
        ),
        el(
          'span',
          {},
          strong('NO CALIBRATION: '),
          'you are in LIVE mode and have not calibrated. Tap IMPORT RAW instead.',
        ),
        el(
          'span',
          {},
          strong('TOO DARK or CLIPPING: '),
          'in LIVE mode, the card is too dark or too bright. Move it, or change the light.',
        ),
      ),
    ),
  );

  screen.appendChild(
    card(
      'One tip for a good reading',
      para(
        'Measure one light at a time. If a lamp and a window both light the room, the app gives you a blend of the two. That blend matches neither one.',
      ),
      para('Turn one off, or take a separate photo for each.'),
    ),
  );

  screen.appendChild(renderTechnical(state, actions, live));

  return screen;
}

/** A small warm-to-cool scale, so the number has something to sit against. */
function kelvinScale(): HTMLElement {
  const rows: [string, string, string][] = [
    ['2700 K', '#ff9040', 'Old light bulb. Very warm and orange.'],
    ['3200 K', '#ffb066', 'Warm indoor lamp.'],
    ['4000 K', '#ffd9b0', 'In between. Many kitchen lights.'],
    ['5500 K', '#f6f4f0', 'Like sunlight at midday.'],
    ['6500 K', '#c7dcff', 'Cool and blue. A cloudy sky through a window.'],
  ];

  return el(
    'div',
    { class: 'kscale' },
    ...rows.map(([label, colour, description]) =>
      el(
        'div',
        { class: 'kscale__row' },
        el('span', { class: 'kscale__swatch', style: `background:${colour}` }),
        el('span', { class: 'kscale__value' }, label),
        el('span', { class: 'kscale__note' }, description),
      ),
    ),
  );
}

/**
 * Everything a beginner does not need, folded away.
 *
 * The camera capability report stays because it is the only honest answer to
 * "why can this app not just lock the white balance" — it lists what this
 * device actually offers, rather than asserting it.
 */
function renderTechnical(
  state: AppState,
  actions: Actions,
  live: LiveController,
): HTMLElement {
  const report = live.capabilityReport();
  const text = formatCapabilityReport(report);
  const hasTrack = report.trackCapabilities !== null;

  const badges = el('div', { class: 'readout__badges', style: 'justify-content:flex-start' });
  if (hasTrack && report.missingForMeasurement.length === 0) {
    badges.appendChild(badge('Camera controls available', 'ok'));
  } else {
    for (const name of report.missingForMeasurement) {
      badges.appendChild(badge(`no ${name}`, 'danger'));
    }
  }

  const body = el(
    'div',
    { class: 'disclosure__body' },
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
      hasTrack
        ? 'Camera capabilities, captured from a live track on this device.'
        : 'Open LIVE once, then come back, to include the camera track’s own capabilities.',
    ),
    badges,
    el('pre', { class: 'code-block' }, text),
    el(
      'div',
      { class: 'btn-row' },
      button('Copy report', 'btn', () => {
        void copyText(text).then((ok) =>
          actions.toast(ok ? 'Report copied.' : 'Copy was blocked by the browser.'),
        );
      }),
      button('Refresh', 'btn', () => actions.refresh()),
    ),
    el(
      'p',
      { class: 'card__note' },
      'If whiteBalanceMode and exposureMode are missing above, no web app on this device can lock the camera, including this one. That is why RAW import exists.',
    ),
  );

  return el(
    'details',
    { class: 'disclosure' },
    el('summary', { class: 'disclosure__summary' }, 'Technical details'),
    body,
  );
}
