/**
 * The measure screen: the one the app exists for.
 */

import {
  REFERENCE_CARDS,
  findCard,
  patchLocation,
  secureContextOk,
  type ReferenceCard,
} from '../live/index.ts';
import type { AppState } from './app.ts';
import type { App } from './app.ts';
import type { LiveController } from './liveController.ts';
import { badge, card, detailList, readout } from './components.ts';
import { button, el, on } from './dom.ts';
import { VERSION_LABEL } from '../version.ts';
import { blockingWarning } from '../reading.ts';

type Actions = App['actions'];

export function renderMeasureScreen(
  state: AppState,
  actions: Actions,
  live: LiveController,
): HTMLElement {
  const screen = el('div', { class: 'screen screen--measure' });

  screen.appendChild(renderModeToggle(state, actions));
  screen.appendChild(readout(state.reading, state.mode));

  if (state.mode === 'raw') {
    screen.appendChild(renderImportControls(state, actions));
  } else {
    screen.appendChild(renderLiveControls(state, actions, live));
  }

  screen.appendChild(renderActionRow(state, actions));

  if (state.reading && state.reading.details.length > 0 && !blockingWarning(state.reading)) {
    screen.appendChild(card('Reading detail', detailList(state.reading.details)));
  } else if (state.reading && blockingWarning(state.reading) && state.reading.details.length > 0) {
    screen.appendChild(card('File detail', detailList(state.reading.details)));
  }

  screen.appendChild(renderProfilePicker(state, actions));
  screen.appendChild(el('p', { class: 'footer-version' }, VERSION_LABEL));

  return screen;
}

function renderModeToggle(state: AppState, actions: Actions): HTMLElement {
  const group = el('div', { class: 'segmented', role: 'group', 'aria-label': 'Measurement mode' });

  for (const [mode, label] of [
    ['raw', 'Import RAW'],
    ['live', 'Live (approx)'],
  ] as const) {
    const node = el(
      'button',
      { type: 'button', 'aria-pressed': String(state.mode === mode) },
      label,
    );
    node.addEventListener('click', () => actions.setMode(mode));
    group.appendChild(node);
  }
  return group;
}

/* ------------------------------------------------------------- raw import */

function renderImportControls(state: AppState, actions: Actions): HTMLElement {
  const container = el('div', {});

  const input = el('input', {
    type: 'file',
    class: 'hidden-input',
    // image/* is included so iOS shows the photo library alongside Files;
    // a HEIC picked from there is rejected by name with an explanation.
    accept: '.dng,.DNG,image/x-adobe-dng,image/tiff,image/*',
  }) as HTMLInputElement;

  const zone = el(
    'div',
    { class: 'dropzone', role: 'button', tabindex: '0' },
    el('div', {}, state.busy ? 'Reading…' : 'Choose a DNG'),
    el(
      'div',
      { class: 'dropzone__hint' },
      'Tap to pick a file, or drag one here. Nothing leaves this device.',
    ),
  );

  const pick = (): void => input.click();
  on(zone, 'click', pick);
  on(zone, 'keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      pick();
    }
  });

  on(zone, 'dragover', (event) => {
    event.preventDefault();
    zone.classList.add('dropzone--active');
  });
  on(zone, 'dragleave', () => zone.classList.remove('dropzone--active'));
  on(zone, 'drop', (event) => {
    event.preventDefault();
    zone.classList.remove('dropzone--active');
    const file = event.dataTransfer?.files?.[0];
    if (file) void actions.importFile(file);
  });

  input.addEventListener('change', () => {
    const file = input.files?.[0];
    if (file) void actions.importFile(file);
    // Reset so picking the same file twice re-reads it.
    input.value = '';
  });

  container.appendChild(zone);
  container.appendChild(input);
  return container;
}

/* -------------------------------------------------------------- live mode */

function renderLiveControls(
  state: AppState,
  actions: Actions,
  live: LiveController,
): HTMLElement {
  const container = el('div', {});

  if (!secureContextOk()) {
    container.appendChild(
      card(
        'Camera unavailable',
        el(
          'p',
          { class: 'card__note' },
          'The camera needs a secure context. Open the app over HTTPS, or on localhost during development.',
        ),
      ),
    );
    return container;
  }

  if (state.liveError) {
    const retry = button('Try again', 'btn btn--primary', () => actions.setMode('live'));
    container.appendChild(
      card('Camera unavailable', el('p', { class: 'card__note' }, state.liveError), retry),
    );
    return container;
  }

  const profile = state.profiles.find(
    (item) => item.id === state.settings.activeLiveProfileId,
  );
  const cardSpec = findCard(profile?.cardId ?? null) ?? REFERENCE_CARDS[0]!;
  live.setCard(cardSpec);
  const ready = (profile?.points.length ?? 0) >= 2;

  // Someone arriving here for the first time sees a grid on a camera preview.
  // Say what it is, and what they need, before showing it - and give them the
  // way back out, because without a card this mode cannot produce anything.
  if (!ready) {
    container.appendChild(renderLiveExplainer(actions, Boolean(profile)));
  }

  // The preview box takes the camera's own shape. It used to be locked to 4:3
  // with object-fit: cover while the camera delivered 16:9, so the sides were
  // cropped away on screen - the overlay was drawn over one framing and the
  // pixels were read from another.
  const viewfinder = el('div', {
    class: 'viewfinder',
    style: `aspect-ratio:${live.videoAspect}`,
  });
  viewfinder.appendChild(live.video);
  viewfinder.appendChild(renderCardGrid(state, live, cardSpec));
  container.appendChild(viewfinder);

  const legend = el('div', { class: 'patch-legend' });
  cardSpec.patches.forEach((patch) => {
    legend.appendChild(
      el(
        'div',
        { class: 'patch-legend__item' },
        el('span', {
          class: 'patch-legend__swatch',
          style: `background:${patch.swatch}`,
        }),
        el('span', {}, `${patch.patchName} — ${patchLocation(patch)}`),
      ),
    );
  });

  container.appendChild(
    card(
      `Fill the grid with your ${cardSpec.name}`,
      el(
        'p',
        { class: 'guide-text', style: 'margin-top:0' },
        'Line the whole card up inside the grid, one patch per box. The app reads the four highlighted boxes.',
      ),
      legend,
      el('p', { class: 'card__note' }, cardSpec.note),
    ),
  );

  return container;
}

/**
 * The alignment grid: one cell per patch on the card, with the four sampled
 * cells picked out.
 *
 * Drawing the whole card rather than four floating boxes is what makes this
 * possible to do at all. The four patches the method needs are not in a
 * straight line on any chart, so a row of four boxes asked the user to line
 * up something that cannot be lined up.
 */
function renderCardGrid(
  state: AppState,
  live: LiveController,
  cardSpec: ReferenceCard,
): HTMLElement {
  const grid = state.liveFrame?.grid ?? live.grid;
  const overlay = el('div', { class: 'viewfinder__guides' });

  const percent = (value: number): string => `${value * 100}%`;
  const cellWidth = grid.width / grid.columns;
  const cellHeight = grid.height / grid.rows;

  const problemRoles = new Set(
    (state.liveFrame?.features.problems ?? []).map((problem) => problem.role),
  );
  const sampled = new Map(
    cardSpec.patches.map((patch) => [`${patch.row}:${patch.column}`, patch]),
  );

  for (let row = 1; row <= grid.rows; row++) {
    for (let column = 1; column <= grid.columns; column++) {
      const patch = sampled.get(`${row}:${column}`);
      const bad = patch ? problemRoles.has(patch.role) : false;
      const classes = ['grid-cell'];
      if (patch) classes.push('grid-cell--sampled');
      if (bad) classes.push('grid-cell--bad');

      const cell = el('div', {
        class: classes.join(' '),
        style:
          `left:${percent(grid.x + (column - 1) * cellWidth)};` +
          `top:${percent(grid.y + (row - 1) * cellHeight)};` +
          `width:${percent(cellWidth)};height:${percent(cellHeight)}`,
      });
      if (patch) {
        // Labels sit above their cell, so one directly under another sampled
        // cell would land on top of it. Flip those below instead.
        const stackedUnder = sampled.has(`${row - 1}:${column}`);
        cell.appendChild(
          el(
            'span',
            {
              class: stackedUnder
                ? 'grid-cell__label grid-cell__label--below'
                : 'grid-cell__label',
            },
            patch.shortName,
          ),
        );
      }
      overlay.appendChild(cell);
    }
  }

  return overlay;
}

/** Plain-language answer to "what are these squares?". */
function renderLiveExplainer(actions: Actions, hasProfile: boolean): HTMLElement {
  return card(
    'What are the squares?',
    el(
      'p',
      { class: 'guide-text', style: 'margin-top:0' },
      'This mode needs a colour checker card. That is a printed card covered in small coloured squares. Photographers use them to check colour.',
    ),
    el(
      'p',
      { class: 'guide-text' },
      'You hold the card up in front of the camera and line each box on screen up with the colour named under it. The app compares those colours to each other to work out the light.',
    ),
    el(
      'p',
      { class: 'guide-note guide-note--warn' },
      hasProfile
        ? 'This profile still needs two calibration points before it can show a number. Until then no reading will appear.'
        : 'If you do not have one of these cards, this mode cannot work. Use IMPORT RAW instead — it is the accurate one anyway.',
    ),
    el(
      'div',
      { class: 'btn-row' },
      button('Use IMPORT RAW instead', 'btn btn--primary', () => actions.setMode('raw')),
    ),
  );
}

/* ------------------------------------------------------------ hold / save */

function renderActionRow(state: AppState, actions: Actions): HTMLElement {
  const row = el('div', { class: 'btn-row' });

  if (state.mode === 'live') {
    row.appendChild(
      button(
        state.held ? 'Held' : 'Hold',
        state.held ? 'btn btn--held' : 'btn',
        () => actions.toggleHold(),
        { 'aria-pressed': String(state.held) },
      ),
    );
  }

  const canSave = Boolean(state.reading && Number.isFinite(state.reading.kelvin));
  row.appendChild(
    button('Save…', 'btn btn--primary', () => openSaveForm(state, actions), {
      disabled: !canSave,
    }),
  );

  return row;
}

function openSaveForm(state: AppState, actions: Actions): void {
  const existing = document.getElementById('save-form');
  if (existing) {
    existing.remove();
    return;
  }

  const labelInput = el('input', {
    type: 'text',
    placeholder: 'Kitchen',
    autocomplete: 'off',
    enterkeyhint: 'done',
  }) as HTMLInputElement;

  const noteInput = el('input', {
    type: 'text',
    placeholder: 'Optional note',
    autocomplete: 'off',
  }) as HTMLInputElement;

  const form = el(
    'section',
    { class: 'card', id: 'save-form' },
    el('h2', { class: 'card__title' }, `Save to ${state.settings.currentSessionName}`),
    el('label', { class: 'field' }, el('span', { class: 'field__label' }, 'Room'), labelInput),
    el('label', { class: 'field' }, el('span', { class: 'field__label' }, 'Note'), noteInput),
  );

  const save = (): void => {
    void actions.saveReading(labelInput.value, noteInput.value);
    form.remove();
  };

  labelInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') save();
  });

  form.appendChild(
    el(
      'div',
      { class: 'btn-row' },
      button('Cancel', 'btn', () => form.remove()),
      button('Save', 'btn btn--primary', save),
    ),
  );

  const row = document.querySelector('.screen--measure .btn-row');
  row?.after(form);
  labelInput.focus();
}

/* ----------------------------------------------------------- profile pick */

function renderProfilePicker(state: AppState, actions: Actions): HTMLElement {
  const forMode = state.profiles.filter((profile) => profile.mode === state.mode);
  const activeId =
    state.mode === 'raw'
      ? state.settings.activeRawProfileId
      : state.settings.activeLiveProfileId;

  const select = el('select', {}) as HTMLSelectElement;
  select.appendChild(el('option', { value: '' }, 'None — uncalibrated'));
  for (const profile of forMode) {
    const option = el(
      'option',
      { value: profile.id, ...(profile.id === activeId ? { selected: true } : {}) },
      `${profile.name} (${profile.points.length} pt)`,
    );
    select.appendChild(option);
  }
  select.addEventListener('change', () => {
    void actions.setActiveProfile(state.mode, select.value || null);
  });

  const children: (Node | string | false | null)[] = [
    el('label', { class: 'field' }, el('span', { class: 'field__label' }, 'Profile'), select),
  ];

  if (forMode.length === 0) {
    children.push(
      el(
        'p',
        { class: 'card__note' },
        state.mode === 'live'
          ? 'Live mode reports nothing until a profile with two or more calibration points exists. Its raw output is a ratio, not a temperature.'
          : 'Raw readings work uncalibrated. A profile corrects for what your camera app does differently from the reference.',
      ),
    );
  }

  children.push(
    el(
      'div',
      { class: 'readout__badges', style: 'justify-content:flex-start;margin-top:10px' },
      badge(`Session: ${state.settings.currentSessionName}`),
      badge(`${state.measurements.length} saved`),
    ),
  );

  return card('Calibration profile', ...children);
}
