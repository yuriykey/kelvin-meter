/**
 * Display formatting, and the single place where measurement precision is
 * decided.
 *
 * The rule from the spec: do not print more precision than the method
 * supports. Both modes therefore round to a step that reflects their real
 * uncertainty, so the last digit on screen is never noise.
 */

export type MeasurementMode = 'raw' | 'live';

export interface ModePrecision {
  /** Kelvin values are rounded to a multiple of this. */
  readonly kelvinStep: number;
  /** Tint values are rounded to a multiple of this. */
  readonly tintStep: number;
  /** Honest one-sigma-ish uncertainty, for display next to the number. */
  readonly uncertaintyLabel: string;
}

export const MODE_PRECISION: Record<MeasurementMode, ModePrecision> = {
  // A DNG's AsShotNeutral is the camera's own illuminant estimate, resolved
  // through the manufacturer's calibration matrices. It is highly repeatable
  // but it is still an estimate made by an algorithm looking at the scene, so
  // absolute accuracy is far better than its repeatability suggests.
  raw: { kelvinStep: 10, tintStep: 1, uncertaintyLabel: '±150 K typical' },
  // Live mode infers the illuminant from residual inter-patch ratios that
  // survive auto white balance. It is a weak signal riding on top of a tone
  // curve nobody documents.
  live: { kelvinStep: 50, tintStep: 5, uncertaintyLabel: '±400 K typical' },
};

export function roundToStep(value: number, step: number): number {
  return Math.round(value / step) * step;
}

export function formatKelvin(kelvin: number, mode: MeasurementMode): string {
  if (!Number.isFinite(kelvin)) return '—';
  const step = MODE_PRECISION[mode].kelvinStep;
  return String(roundToStep(kelvin, step));
}

export function formatTint(tint: number, mode: MeasurementMode): string {
  if (!Number.isFinite(tint)) return '—';
  const step = MODE_PRECISION[mode].tintStep;
  const rounded = roundToStep(tint, step);
  return rounded > 0 ? `+${rounded}` : String(rounded);
}

/** Duv carries four decimals in every standard that defines it. */
export function formatDuv(duv: number): string {
  if (!Number.isFinite(duv)) return '—';
  const sign = duv >= 0 ? '+' : '−';
  return `${sign}${Math.abs(duv).toFixed(4)}`;
}

export function formatXY(x: number, y: number): string {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return '—';
  return `${x.toFixed(4)}, ${y.toFixed(4)}`;
}

export function formatMired(mired: number): string {
  if (!Number.isFinite(mired)) return '—';
  return mired.toFixed(1);
}

/** Human description of where a reading sits relative to the Planckian locus. */
export function describeDuv(duv: number): string {
  const magnitude = Math.abs(duv);
  if (magnitude < 0.002) return 'on the blackbody locus';
  const direction = duv > 0 ? 'green' : 'magenta';
  if (magnitude < 0.006) return `slightly ${direction}`;
  if (magnitude < 0.015) return `${direction}`;
  return `strongly ${direction}`;
}
