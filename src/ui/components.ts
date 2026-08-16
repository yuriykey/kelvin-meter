/**
 * Shared presentational pieces.
 */

import {
  MODE_PRECISION,
  describeDuv,
  formatKelvin,
  formatTint,
  type MeasurementMode,
} from '../color/index.ts';
import { type Reading, blockingWarning } from '../reading.ts';
import { el } from './dom.ts';

export function badge(text: string, variant?: 'ok' | 'warn' | 'danger' | 'approx'): HTMLElement {
  return el('span', { class: variant ? `badge badge--${variant}` : 'badge' }, text);
}

/**
 * The primary readout.
 *
 * A blocking warning takes the place of the number entirely. Anything less
 * gets ignored at arm's length in a dim room, which is precisely the
 * situation this screen exists for.
 */
export function readout(reading: Reading | null, mode: MeasurementMode): HTMLElement {
  if (!reading) {
    return el(
      'div',
      { class: 'readout' },
      el(
        'p',
        { class: 'readout__empty' },
        mode === 'raw'
          ? 'Pick a DNG to read the light the camera actually saw.'
          : 'Point the camera at your reference card and line up the guide boxes.',
      ),
    );
  }

  const blocking = blockingWarning(reading);
  if (blocking) {
    return el(
      'div',
      { class: 'readout readout--warning', role: 'status' },
      el('p', { class: 'readout__warning' }, blocking.kind),
      el('p', { class: 'readout__warning-detail' }, blocking.detail),
    );
  }

  const soft = reading.warnings.filter((warning) => !warning.blocking);
  const precision = MODE_PRECISION[reading.mode];

  const badges: HTMLElement[] = [];
  badges.push(
    reading.calibrated
      ? badge(
          reading.profileName ? `Calibrated · ${reading.profileName}` : 'Calibrated',
          'ok',
        )
      : badge('Uncalibrated', 'warn'),
  );
  if (reading.mode === 'live') badges.push(badge('Live (approx)', 'approx'));
  if (reading.extrapolated) badges.push(badge('Extrapolated', 'warn'));
  if (Number.isFinite(reading.duv)) badges.push(badge(describeDuv(reading.duv)));

  return el(
    'div',
    { class: 'readout', role: 'status' },
    el(
      'p',
      { class: 'readout__kelvin' },
      formatKelvin(reading.kelvin, reading.mode),
      el('sup', {}, 'K'),
    ),
    el(
      'p',
      { class: 'readout__tint' },
      `tint ${formatTint(reading.tint, reading.mode)}`,
    ),
    el('p', { class: 'readout__uncertainty' }, precision.uncertaintyLabel),
    el('div', { class: 'readout__badges' }, ...badges),
    ...soft.map((warning) =>
      el('p', { class: 'readout__uncertainty', style: 'color:var(--caution)' }, warning.detail),
    ),
  );
}

export function detailList(rows: readonly { label: string; value: string }[]): HTMLElement {
  const list = el('dl', { class: 'detail-list' });
  for (const row of rows) {
    list.appendChild(el('dt', {}, row.label));
    list.appendChild(el('dd', {}, row.value));
  }
  return list;
}

export function card(title: string, ...children: (Node | string | false | null)[]): HTMLElement {
  return el('section', { class: 'card' }, el('h2', { class: 'card__title' }, title), ...children);
}

export function field(
  labelText: string,
  control: HTMLElement,
): HTMLElement {
  return el(
    'label',
    { class: 'field' },
    el('span', { class: 'field__label' }, labelText),
    control,
  );
}

export function emptyState(message: string): HTMLElement {
  return el('p', { class: 'empty-state' }, message);
}

export function sectionHeader(title: string, subtitle?: string): HTMLElement {
  return el(
    'header',
    {},
    el('h1', { class: 'section-title' }, title),
    subtitle ? el('p', { class: 'section-subtitle' }, subtitle) : null,
  );
}
