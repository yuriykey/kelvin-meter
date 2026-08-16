/**
 * Calibration screen.
 *
 * The plot is drawn in mired, not Kelvin, because that is the space the fit
 * lives in. Plotting it in Kelvin would show a curve that looks wildly
 * non-linear at the tungsten end purely because of the axis, and would hide
 * how well the fit actually behaves.
 */

import {
  REFERENCE_SOURCES,
  kelvinToMired,
  miredToKelvin,
  type MeasurementMode,
} from '../color/index.ts';
import {
  type CalibrationProfile,
  addPoint,
  clearTrim,
  fitTintOffset,
  profileResiduals,
  removePoint,
  withFieldTrim,
  withTintOffset,
} from '../calibration/index.ts';
import { REFERENCE_CARDS } from '../live/index.ts';
import type { App, AppState } from './app.ts';
import { badge, card, emptyState, sectionHeader } from './components.ts';
import { button, el } from './dom.ts';

type Actions = App['actions'];

export function renderCalibrateScreen(state: AppState, actions: Actions): HTMLElement {
  const screen = el('div', { class: 'screen' });

  screen.appendChild(
    sectionHeader('Calibration', 'Fitted in mired, so corrections behave evenly across the range'),
  );

  const activeId =
    state.mode === 'raw'
      ? state.settings.activeRawProfileId
      : state.settings.activeLiveProfileId;
  const profile = state.profiles.find((item) => item.id === activeId) ?? null;

  screen.appendChild(renderProfileList(state, actions));

  if (profile) {
    screen.appendChild(renderAddPoint(state, actions, profile));
    screen.appendChild(renderPlot(profile));
    screen.appendChild(renderPoints(profile, actions));
    screen.appendChild(renderTrim(state, actions, profile));
    screen.appendChild(renderDangerZone(actions, profile));
  }

  screen.appendChild(renderBackup(state, actions));
  screen.appendChild(renderGuidance());

  return screen;
}

/* ------------------------------------------------------------- profiles */

function renderProfileList(state: AppState, actions: Actions): HTMLElement {
  const children: (Node | string | false | null)[] = [];

  const modeSelect = el('select', {}) as HTMLSelectElement;
  for (const [mode, label] of [
    ['raw', 'RAW import'],
    ['live', 'Live camera'],
  ] as const) {
    modeSelect.appendChild(
      el('option', { value: mode, ...(state.mode === mode ? { selected: true } : {}) }, label),
    );
  }
  modeSelect.addEventListener('change', () =>
    actions.setMode(modeSelect.value as MeasurementMode),
  );
  children.push(
    el('label', { class: 'field' }, el('span', { class: 'field__label' }, 'Mode'), modeSelect),
  );

  const forMode = state.profiles.filter((profile) => profile.mode === state.mode);
  const activeId =
    state.mode === 'raw'
      ? state.settings.activeRawProfileId
      : state.settings.activeLiveProfileId;

  const select = el('select', {}) as HTMLSelectElement;
  select.appendChild(el('option', { value: '' }, 'None selected'));
  for (const profile of forMode) {
    select.appendChild(
      el(
        'option',
        { value: profile.id, ...(profile.id === activeId ? { selected: true } : {}) },
        profile.name,
      ),
    );
  }
  select.addEventListener('change', () =>
    void actions.setActiveProfile(state.mode, select.value || null),
  );
  children.push(
    el('label', { class: 'field' }, el('span', { class: 'field__label' }, 'Active profile'), select),
  );

  children.push(renderNewProfileForm(state, actions));

  return card('Profiles', ...children);
}

function renderNewProfileForm(state: AppState, actions: Actions): HTMLElement {
  const nameInput = el('input', {
    type: 'text',
    placeholder: state.mode === 'raw' ? 'ProRAW / iPhone 15 Pro' : 'Passport / iPhone 15 Pro',
    autocomplete: 'off',
  }) as HTMLInputElement;

  const notesInput = el('input', {
    type: 'text',
    placeholder: 'Camera app, phone, anything that would change the numbers',
    autocomplete: 'off',
  }) as HTMLInputElement;

  const cardSelect = el('select', {}) as HTMLSelectElement;
  for (const reference of REFERENCE_CARDS) {
    cardSelect.appendChild(el('option', { value: reference.id }, reference.name));
  }

  const container = el(
    'div',
    { style: 'margin-top:14px;border-top:1px solid var(--line);padding-top:12px' },
    el('p', { class: 'card__title' }, 'New profile'),
    el('label', { class: 'field' }, el('span', { class: 'field__label' }, 'Name'), nameInput),
    el('label', { class: 'field' }, el('span', { class: 'field__label' }, 'Notes'), notesInput),
  );

  if (state.mode === 'live') {
    container.appendChild(
      el(
        'label',
        { class: 'field' },
        el('span', { class: 'field__label' }, 'Reference card'),
        cardSelect,
      ),
    );
    container.appendChild(
      el(
        'p',
        { class: 'card__note' },
        'The calibration is bound to this specific card. A profile fitted against one card says nothing about another.',
      ),
    );
  }

  container.appendChild(
    el(
      'div',
      { class: 'btn-row' },
      button('Create profile', 'btn btn--primary', () => {
        void actions.createProfile(
          nameInput.value,
          state.mode,
          notesInput.value,
          state.mode === 'live' ? cardSelect.value : null,
        );
      }),
    ),
  );

  return container;
}

/* ----------------------------------------------------------- add a point */

function renderAddPoint(
  state: AppState,
  actions: Actions,
  profile: CalibrationProfile,
): HTMLElement {
  const reading = state.reading;
  const usable =
    reading !== null &&
    reading.mode === profile.mode &&
    (profile.mode === 'raw'
      ? Number.isFinite(reading.rawKelvin)
      : reading.feature !== null);

  if (!usable) {
    return card(
      'Add a calibration point',
      el(
        'p',
        { class: 'card__note' },
        profile.mode === 'raw'
          ? 'Import a DNG of a light whose colour temperature you know, then come back here.'
          : 'Point the camera at your card under a light whose colour temperature you know, then come back here.',
      ),
    );
  }

  const sourceSelect = el('select', {}) as HTMLSelectElement;
  sourceSelect.appendChild(el('option', { value: '' }, 'Type a value…'));
  for (const source of REFERENCE_SOURCES) {
    sourceSelect.appendChild(
      el(
        'option',
        { value: String(source.kelvin) },
        `${source.label} — ${source.kelvin} K ${source.tolerance}`,
      ),
    );
  }

  const kelvinInput = el('input', {
    type: 'number',
    inputmode: 'numeric',
    min: '1500',
    max: '25000',
    step: '10',
    placeholder: 'Known CCT in Kelvin',
  }) as HTMLInputElement;

  sourceSelect.addEventListener('change', () => {
    if (sourceSelect.value) kelvinInput.value = sourceSelect.value;
  });

  const measuredText =
    profile.mode === 'raw'
      ? `${Math.round(reading.rawKelvin)} K (${kelvinToMired(reading.rawKelvin).toFixed(1)} mired)`
      : `feature ${reading.feature!.toFixed(4)}`;

  return card(
    'Add a calibration point',
    el(
      'p',
      { class: 'card__note', style: 'margin-top:0' },
      `Current measurement: ${measuredText}`,
    ),
    el(
      'label',
      { class: 'field' },
      el('span', { class: 'field__label' }, 'Reference source'),
      sourceSelect,
    ),
    el(
      'label',
      { class: 'field' },
      el('span', { class: 'field__label' }, 'Known colour temperature'),
      kelvinInput,
    ),
    el(
      'div',
      { class: 'btn-row' },
      button('Store point', 'btn btn--primary', () => {
        const kelvin = Number(kelvinInput.value);
        if (!Number.isFinite(kelvin) || kelvin < 1500 || kelvin > 25000) {
          actions.toast('Enter a colour temperature between 1500 K and 25000 K.');
          return;
        }
        const measured =
          profile.mode === 'raw' ? kelvinToMired(reading.rawKelvin) : reading.feature!;
        const updated = addPoint(profile, {
          measured,
          referenceKelvin: kelvin,
          measuredTint: Number.isFinite(reading.rawTint) ? reading.rawTint : 0,
          referenceTint: 0,
          label: `${kelvin} K`,
        });
        void actions.updateProfile(updated);
        actions.toast(`Stored ${kelvin} K.`);
      }),
    ),
  );
}

/* ------------------------------------------------------------- the plot */

/**
 * Stored points and the fitted curve, in mired.
 *
 * Drawn as inline SVG so it scales, needs no canvas sizing dance, and works
 * offline like everything else here.
 */
function renderPlot(profile: CalibrationProfile): HTMLElement {
  if (profile.points.length === 0) {
    return card('Fit', emptyState('No points stored yet.'));
  }
  if (profile.points.length === 1) {
    // One point defines no curve, and plotting it alone produces axes spanning
    // a few Kelvin either side of a single dot, which reads as precision that
    // is not there.
    return card(
      'Fit',
      emptyState(
        profile.mode === 'raw'
          ? 'One point so far. It is being applied as a constant offset. Store a second point at the other end of the range to fit a curve.'
          : 'One point so far. Live mode needs at least two before it can report a temperature at all.',
      ),
    );
  }

  const width = 320;
  const height = 190;
  const pad = { left: 42, right: 12, top: 12, bottom: 30 };

  const xs = profile.points.map((point) => point.measured);
  const ys = profile.points.map((point) => kelvinToMired(point.referenceKelvin));

  const xRange = padRange(Math.min(...xs), Math.max(...xs));
  const yRange = padRange(Math.min(...ys), Math.max(...ys));

  const plotWidth = width - pad.left - pad.right;
  const plotHeight = height - pad.top - pad.bottom;

  const sx = (value: number): number =>
    pad.left + ((value - xRange.min) / (xRange.max - xRange.min)) * plotWidth;
  const sy = (value: number): number =>
    pad.top + plotHeight - ((value - yRange.min) / (yRange.max - yRange.min)) * plotHeight;

  const svgNs = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNs, 'svg');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('class', 'plot');
  svg.setAttribute('role', 'img');
  svg.setAttribute(
    'aria-label',
    `Calibration fit with ${profile.points.length} points, plotted in mired`,
  );

  const line = (x1: number, y1: number, x2: number, y2: number, stroke: string, dash?: string) => {
    const node = document.createElementNS(svgNs, 'line');
    node.setAttribute('x1', String(x1));
    node.setAttribute('y1', String(y1));
    node.setAttribute('x2', String(x2));
    node.setAttribute('y2', String(y2));
    node.setAttribute('stroke', stroke);
    node.setAttribute('stroke-width', '1');
    if (dash) node.setAttribute('stroke-dasharray', dash);
    svg.appendChild(node);
  };

  const text = (x: number, y: number, value: string, anchor: string) => {
    const node = document.createElementNS(svgNs, 'text');
    node.setAttribute('x', String(x));
    node.setAttribute('y', String(y));
    node.setAttribute('fill', '#63738a');
    node.setAttribute('font-size', '9');
    node.setAttribute('text-anchor', anchor);
    node.textContent = value;
    svg.appendChild(node);
  };

  // Axes.
  line(pad.left, pad.top, pad.left, pad.top + plotHeight, '#253040');
  line(pad.left, pad.top + plotHeight, pad.left + plotWidth, pad.top + plotHeight, '#253040');

  for (const fraction of [0, 0.5, 1]) {
    const xValue = xRange.min + fraction * (xRange.max - xRange.min);
    const yValue = yRange.min + fraction * (yRange.max - yRange.min);
    line(sx(xValue), pad.top, sx(xValue), pad.top + plotHeight, '#1b2430', '2 3');
    line(pad.left, sy(yValue), pad.left + plotWidth, sy(yValue), '#1b2430', '2 3');
    text(
      sx(xValue),
      height - 16,
      profile.mode === 'raw' ? xValue.toFixed(0) : xValue.toFixed(2),
      'middle',
    );
    text(pad.left - 5, sy(yValue) + 3, `${Math.round(miredToKelvin(yValue))}K`, 'end');
  }

  text(pad.left + plotWidth / 2, height - 3, axisLabel(profile.mode), 'middle');

  // The fitted curve: a polyline through the stored points after the
  // monotonic fit, so what is drawn is exactly what is applied.
  const residuals = profileResiduals(profile);
  const fitted = profile.points
    .map((point, index) => ({
      x: point.measured,
      y: kelvinToMired(point.referenceKelvin) + (residuals[index]?.miredResidual ?? 0),
    }))
    .sort((a, b) => a.x - b.x);

  if (fitted.length > 1) {
    const path = document.createElementNS(svgNs, 'polyline');
    path.setAttribute('points', fitted.map((p) => `${sx(p.x)},${sy(p.y)}`).join(' '));
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', '#7ab0ff');
    path.setAttribute('stroke-width', '2');
    svg.appendChild(path);
  }

  // Stored points.
  for (const point of profile.points) {
    const dot = document.createElementNS(svgNs, 'circle');
    dot.setAttribute('cx', String(sx(point.measured)));
    dot.setAttribute('cy', String(sy(kelvinToMired(point.referenceKelvin))));
    dot.setAttribute('r', '3.5');
    dot.setAttribute('fill', '#ffac58');
    svg.appendChild(dot);
  }

  return card(
    'Fit',
    svg,
    el(
      'p',
      { class: 'card__note' },
      'Plotted in mired. The correction is held flat past the outermost points rather than extrapolated.',
    ),
  );
}

function axisLabel(mode: MeasurementMode): string {
  return mode === 'raw' ? 'measured (mired)' : 'warmth feature';
}

function padRange(min: number, max: number): { min: number; max: number } {
  if (max - min < 1e-6) return { min: min - 1, max: max + 1 };
  const margin = (max - min) * 0.12;
  return { min: min - margin, max: max + margin };
}

/* ------------------------------------------------------------ point list */

function renderPoints(profile: CalibrationProfile, actions: Actions): HTMLElement {
  if (profile.points.length === 0) {
    return card(
      'Stored points',
      emptyState('Take a reading of a known source and store it above.'),
    );
  }

  const residuals = profileResiduals(profile);
  const container = el('div', {});

  residuals.forEach(({ point, kelvinResidual }) => {
    const high = Math.abs(kelvinResidual) > 100;
    const row = el(
      'div',
      { class: 'point-row' },
      el(
        'div',
        { class: 'point-row__main' },
        el('div', {}, `${point.referenceKelvin} K reference`),
        el(
          'div',
          { style: 'font-size:12px;color:var(--text-faint)' },
          profile.mode === 'raw'
            ? `measured ${Math.round(miredToKelvin(point.measured))} K`
            : `feature ${point.measured.toFixed(4)}`,
        ),
      ),
      el(
        'span',
        { class: high ? 'point-row__residual point-row__residual--high' : 'point-row__residual' },
        Number.isFinite(kelvinResidual)
          ? `${kelvinResidual >= 0 ? '+' : ''}${Math.round(kelvinResidual)} K`
          : '—',
      ),
      button('×', 'btn btn--small btn--danger', () => {
        void actions.updateProfile(removePoint(profile, point.id));
      }, { 'aria-label': `Delete ${point.referenceKelvin} K point` }),
    );
    container.appendChild(row);
  });

  const suggested = fitTintOffset(profile);
  const children: (Node | string | false | null)[] = [container];

  if (residuals.some((residual) => Math.abs(residual.kelvinResidual) > 100)) {
    children.push(
      el(
        'p',
        { class: 'card__note' },
        'A residual above 100 K means two stored points disagree with each other. The fit pools them rather than folding back on itself — check whether one of the reference sources is not what its label claims.',
      ),
    );
  }

  if (Math.abs(suggested - profile.tintOffset) > 0.5) {
    children.push(
      el(
        'div',
        { class: 'btn-row' },
        button(`Apply fitted tint offset (${suggested.toFixed(1)})`, 'btn', () => {
          void actions.updateProfile({
            ...profile,
            tintOffset: suggested,
            updatedAt: Date.now(),
          });
        }),
      ),
    );
  }

  return card('Stored points', ...children);
}

/* ------------------------------------------------------------ field trim */

function renderTrim(
  state: AppState,
  actions: Actions,
  profile: CalibrationProfile,
): HTMLElement {
  const reading = state.reading;
  const children: (Node | string | false | null)[] = [];

  children.push(
    el(
      'div',
      { class: 'readout__badges', style: 'justify-content:flex-start' },
      badge(`Temperature trim ${profile.miredTrim >= 0 ? '+' : ''}${profile.miredTrim.toFixed(1)} mired`),
      badge(`Tint offset ${profile.tintOffset >= 0 ? '+' : ''}${profile.tintOffset.toFixed(1)}`),
    ),
  );

  if (reading && Number.isFinite(reading.kelvin) && reading.mode === profile.mode) {
    const actualInput = el('input', {
      type: 'number',
      inputmode: 'numeric',
      min: '1500',
      max: '25000',
      step: '10',
      placeholder: String(Math.round(reading.kelvin)),
    }) as HTMLInputElement;

    children.push(
      el(
        'label',
        { class: 'field' },
        el(
          'span',
          { class: 'field__label' },
          `Reading is ${Math.round(reading.kelvin)} K — this light is actually`,
        ),
        actualInput,
      ),
      el(
        'div',
        { class: 'btn-row' },
        button('Apply trim', 'btn', () => {
          const actual = Number(actualInput.value);
          if (!Number.isFinite(actual) || actual < 1500 || actual > 25000) {
            actions.toast('Enter a colour temperature between 1500 K and 25000 K.');
            return;
          }
          void actions.updateProfile(withFieldTrim(profile, reading.kelvin, actual));
          actions.toast('Trim applied.');
        }),
      ),
    );

    if (Number.isFinite(reading.tint)) {
      const tintInput = el('input', {
        type: 'number',
        inputmode: 'numeric',
        min: '-150',
        max: '150',
        step: '1',
        placeholder: String(Math.round(reading.tint)),
      }) as HTMLInputElement;

      children.push(
        el(
          'label',
          { class: 'field' },
          el(
            'span',
            { class: 'field__label' },
            `Tint reads ${Math.round(reading.tint)} — it should be`,
          ),
          tintInput,
        ),
        el(
          'div',
          { class: 'btn-row' },
          button('Apply tint offset', 'btn', () => {
            const actual = Number(tintInput.value);
            if (!Number.isFinite(actual)) {
              actions.toast('Enter a tint between -150 and 150.');
              return;
            }
            void actions.updateProfile(withTintOffset(profile, reading.tint, actual));
            actions.toast('Tint offset applied.');
          }),
        ),
      );
    }
  } else {
    children.push(
      el('p', { class: 'card__note' }, 'Take a reading in this mode to apply a field trim.'),
    );
  }

  if (profile.miredTrim !== 0 || profile.tintOffset !== 0) {
    children.push(
      el(
        'div',
        { class: 'btn-row' },
        button('Clear trims', 'btn btn--danger', () => {
          void actions.updateProfile(clearTrim(profile));
        }),
      ),
    );
  }

  return card('Field trim', ...children);
}

function renderDangerZone(actions: Actions, profile: CalibrationProfile): HTMLElement {
  return card(
    'Profile',
    el('p', { class: 'card__note', style: 'margin-top:0' }, profile.notes || 'No notes.'),
    el(
      'div',
      { class: 'btn-row' },
      button('Delete this profile', 'btn btn--danger', () => {
        void actions.deleteProfile(profile.id);
        actions.toast(`Deleted "${profile.name}".`);
      }),
    ),
  );
}

/* --------------------------------------------------------------- backup */

function renderBackup(state: AppState, actions: Actions): HTMLElement {
  const input = el('input', {
    type: 'file',
    accept: '.json,application/json',
    class: 'hidden-input',
  }) as HTMLInputElement;

  input.addEventListener('change', () => {
    const file = input.files?.[0];
    if (!file) return;
    void file.text().then((text) => actions.importBackup(text));
    input.value = '';
  });

  const lastExport = state.settings.lastExportAt
    ? new Date(state.settings.lastExportAt).toLocaleString()
    : 'never';

  return card(
    'Backup',
    el(
      'p',
      { class: 'card__note', style: 'margin-top:0' },
      `Last export: ${lastExport}. iOS evicts web app storage from sites it has not seen in a while, and adding this to the home screen does not exempt it. Export after every calibration change.`,
    ),
    el(
      'div',
      { class: 'btn-row' },
      button('Export JSON', 'btn btn--primary', () => void actions.exportBackup()),
      button('Import JSON', 'btn', () => input.click()),
    ),
    input,
  );
}

function renderGuidance(): HTMLElement {
  return card(
    'What to calibrate against',
    el(
      'div',
      { class: 'prose' },
      el(
        'p',
        {},
        'A bi-colour LED panel with calibrated presets is the practical reference. Set it to a preset, fill the frame, take a reading, store the point.',
      ),
      el(
        'p',
        {},
        'A household bulb’s box rating is ±150 K at best, and cheap ones are worse. Usable as a rough anchor, not as truth. If you only have bulbs, store several across the range rather than trusting any one of them.',
      ),
      el(
        'p',
        {},
        'Two points at opposite ends beat five points bunched together. The fit interpolates between what you give it and holds flat outside, so the span matters more than the count.',
      ),
    ),
  );
}
