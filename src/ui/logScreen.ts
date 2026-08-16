/**
 * Saved measurements, grouped by session.
 *
 * A mixed-lighting interior is the real use case: kitchen 2750 K, living room
 * 4100 K, windows 6200 K. That list is the working output of the whole app, so
 * getting it out — as CSV, or as text pasted into a note — matters as much as
 * taking the readings.
 */

import { formatKelvin, formatTint } from '../color/index.ts';
import { measurementsToCsv, measurementsToText } from '../storage/exportImport.ts';
import type { StoredMeasurement } from '../storage/db.ts';
import type { App, AppState } from './app.ts';
import { badge, card, emptyState, sectionHeader } from './components.ts';
import { button, copyText, downloadText, el, formatDateOnly, formatTimestamp } from './dom.ts';

type Actions = App['actions'];

export function renderLogScreen(state: AppState, actions: Actions): HTMLElement {
  const screen = el('div', { class: 'screen' });

  screen.appendChild(
    sectionHeader(
      'Shoot log',
      `${state.measurements.length} reading${state.measurements.length === 1 ? '' : 's'}`,
    ),
  );

  screen.appendChild(renderSessionControls(state, actions));

  if (state.measurements.length === 0) {
    screen.appendChild(
      emptyState('No readings yet. Take one on the measure screen and tap Save.'),
    );
    return screen;
  }

  screen.appendChild(renderExportRow(state, actions));

  for (const group of groupBySession(state.measurements)) {
    screen.appendChild(renderSessionGroup(group, state, actions));
  }

  return screen;
}

interface SessionGroup {
  readonly sessionId: string;
  readonly sessionName: string;
  readonly measurements: StoredMeasurement[];
  readonly latest: number;
}

function groupBySession(measurements: readonly StoredMeasurement[]): SessionGroup[] {
  const groups = new Map<string, SessionGroup>();
  for (const measurement of measurements) {
    const existing = groups.get(measurement.sessionId);
    if (existing) {
      existing.measurements.push(measurement);
    } else {
      groups.set(measurement.sessionId, {
        sessionId: measurement.sessionId,
        sessionName: measurement.sessionName,
        measurements: [measurement],
        latest: measurement.createdAt,
      });
    }
  }
  return [...groups.values()]
    .map((group) => ({
      ...group,
      latest: Math.max(...group.measurements.map((m) => m.createdAt)),
    }))
    .sort((a, b) => b.latest - a.latest);
}

function renderSessionControls(state: AppState, actions: Actions): HTMLElement {
  const nameInput = el('input', {
    type: 'text',
    value: state.settings.currentSessionName,
    autocomplete: 'off',
  }) as HTMLInputElement;

  nameInput.addEventListener('change', () => void actions.renameSession(nameInput.value));

  return card(
    'Current session',
    el(
      'label',
      { class: 'field' },
      el('span', { class: 'field__label' }, 'Name'),
      nameInput,
    ),
    el(
      'div',
      { class: 'btn-row' },
      button('Start new session', 'btn', () => {
        const suggested = `Session ${new Date().toLocaleDateString()}`;
        void actions.startNewSession(suggested);
      }),
    ),
  );
}

function renderExportRow(state: AppState, actions: Actions): HTMLElement {
  const all = [...state.measurements].sort((a, b) => a.createdAt - b.createdAt);

  return el(
    'div',
    { class: 'btn-row' },
    button('Copy as text', 'btn', () => {
      void copyText(measurementsToText(all)).then((ok) =>
        actions.toast(ok ? 'Shoot log copied.' : 'Copy was blocked by the browser.'),
      );
    }),
    button('Export CSV', 'btn', () => {
      const stamp = new Date().toISOString().slice(0, 10);
      downloadText(`kelvinmeter-log-${stamp}.csv`, 'text/csv;charset=utf-8', measurementsToCsv(all));
      actions.toast('CSV exported.');
    }),
  );
}

function renderSessionGroup(
  group: SessionGroup,
  state: AppState,
  actions: Actions,
): HTMLElement {
  const section = el('section', { class: 'session-group' });

  const copyButton = button('Copy', 'btn btn--small', () => {
    const ordered = [...group.measurements].sort((a, b) => a.createdAt - b.createdAt);
    void copyText(measurementsToText(ordered)).then((ok) =>
      actions.toast(ok ? `Copied ${group.sessionName}.` : 'Copy was blocked by the browser.'),
    );
  });

  section.appendChild(
    el(
      'header',
      { class: 'session-group__header' },
      el('h2', { class: 'session-group__name' }, group.sessionName),
      el(
        'span',
        { class: 'session-group__meta' },
        `${formatDateOnly(group.latest)} · ${group.measurements.length}`,
      ),
      copyButton,
    ),
  );

  const ordered = [...group.measurements].sort((a, b) => b.createdAt - a.createdAt);
  for (const measurement of ordered) {
    section.appendChild(renderMeasurement(measurement, state, actions));
  }

  return section;
}

function renderMeasurement(
  measurement: StoredMeasurement,
  _state: AppState,
  actions: Actions,
): HTMLElement {
  const meta: string[] = [formatTimestamp(measurement.createdAt)];
  if (measurement.mode === 'live') meta.push('live (approx)');
  if (measurement.profileName) meta.push(measurement.profileName);
  if (measurement.note) meta.push(measurement.note);

  const row = el(
    'div',
    { class: 'measurement' },
    el(
      'div',
      { class: 'measurement__body' },
      el('p', { class: 'measurement__label' }, measurement.label || 'Unlabelled'),
      el('p', { class: 'measurement__meta' }, meta.join(' · ')),
    ),
    el(
      'div',
      { class: 'measurement__value' },
      formatKelvin(measurement.kelvin, measurement.mode),
      el('small', {}, 'K'),
    ),
  );

  if (Math.round(measurement.tint) !== 0) {
    row.querySelector('.measurement__meta')!.textContent +=
      ` · tint ${formatTint(measurement.tint, measurement.mode)}`;
  }

  if (!measurement.calibrated) {
    row.querySelector('.measurement__body')!.appendChild(
      el('div', { style: 'margin-top:4px' }, badge('Uncalibrated', 'warn')),
    );
  }

  row.appendChild(
    button('Delete', 'btn btn--small btn--danger', () => {
      void actions.deleteMeasurement(measurement.id);
    }),
  );

  return row;
}
