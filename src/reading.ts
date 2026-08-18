/**
 * Composes a displayable reading from a measurement and a calibration profile.
 *
 * This is where the warning states are decided. The rule from the spec is that
 * a warning replaces the number rather than sitting next to it: a photographer
 * glancing at the screen from across a dim room will read a big number and act
 * on it, and a caveat printed underneath will not stop them. If the reading
 * cannot be trusted, there is no number on screen at all.
 */

import {
  type MeasurementMode,
  type XY,
  DUV_VALIDITY_LIMIT,
  formatMired,
  ROBERTSON_MAX_KELVIN,
  ROBERTSON_MIN_KELVIN,
  kelvinToMired,
} from './color/index.ts';
import { type CalibrationProfile, applyCalibration } from './calibration/index.ts';
import type { FeatureResult } from './live/index.ts';
import type { SolveResult } from './dng/index.ts';

export type WarningKind =
  | 'CLIPPING'
  | 'TOO DARK'
  | 'NO CALIBRATION'
  | 'UNSUPPORTED FILE'
  | 'OFF LOCUS'
  | 'OUT OF RANGE'
  | 'ALIGN CARD'
  | 'UNSTABLE';

export interface Warning {
  readonly kind: WarningKind;
  readonly detail: string;
  /** A blocking warning replaces the reading; a soft one sits beside it. */
  readonly blocking: boolean;
}

export interface DetailRow {
  readonly label: string;
  readonly value: string;
}

export interface Reading {
  readonly mode: MeasurementMode;
  /** After calibration. The number on screen. */
  readonly kelvin: number;
  readonly tint: number;
  /** Before calibration, kept so the calibration screen can fit against it. */
  readonly rawKelvin: number;
  readonly rawTint: number;
  readonly duv: number;
  readonly xy: XY;
  readonly calibrated: boolean;
  readonly extrapolated: boolean;
  readonly profileName: string | null;
  readonly profileId: string | null;
  /** Which tag or method produced this, for the auditable readout. */
  readonly source: string;
  /** Live mode's AWB-invariant feature, stored so it can be calibrated later. */
  readonly feature: number | null;
  readonly warnings: readonly Warning[];
  readonly details: readonly DetailRow[];
  readonly createdAt: number;
}

export function blockingWarning(reading: Reading | null): Warning | null {
  if (!reading) return null;
  return reading.warnings.find((warning) => warning.blocking) ?? null;
}

/** Reading from an imported DNG. */
export function readingFromDng(
  solve: SolveResult,
  profile: CalibrationProfile | null,
  fileName: string,
): Reading {
  const measurement = solve.measurement;
  const adobe = solve.adobe;
  const corrected = applyCalibration(profile, {
    kelvin: measurement.kelvin,
    tint: adobe.tint,
  });

  const warnings: Warning[] = [];

  if (measurement.cctOutOfRange) {
    warnings.push({
      kind: 'OUT OF RANGE',
      detail: `The illuminant works out beyond ${Math.round(ROBERTSON_MIN_KELVIN)}-${Math.round(
        ROBERTSON_MAX_KELVIN,
      )} K, which no correlated colour temperature describes.`,
      blocking: true,
    });
  }

  if (measurement.farFromLocus) {
    warnings.push({
      kind: 'OFF LOCUS',
      detail: `Duv is ${measurement.duv.toFixed(4)}, past the ±${DUV_VALIDITY_LIMIT} limit where a colour temperature stops meaning anything. Set white balance from the tint as well.`,
      blocking: true,
    });
  }

  if (!solve.converged) {
    warnings.push({
      kind: 'OUT OF RANGE',
      detail: 'The illuminant solve did not settle. This file’s colour matrices may be damaged.',
      blocking: true,
    });
  }

  if (corrected.extrapolated) {
    warnings.push({
      kind: 'OUT OF RANGE',
      detail: 'This reading is outside the calibrated span, so the last known correction is being held.',
      blocking: false,
    });
  }

  const details: DetailRow[] = [
    { label: 'File', value: fileName },
    { label: 'Source tag', value: solve.source },
    { label: 'Duv', value: formatSignedFixed(measurement.duv, 4) },
    { label: 'CIE xy', value: `${solve.xy.x.toFixed(4)}, ${solve.xy.y.toFixed(4)}` },
    { label: 'Mired', value: formatMired(kelvinToMired(measurement.kelvin)) },
    { label: 'Uncorrected', value: `${Math.round(measurement.kelvin)} K` },
  ];

  if (solve.interpolation) {
    // Named rather than described as "warm" or "cool" alone, because a low
    // colour temperature is warm light and the two words invert on each other.
    const blend = solve.interpolation;
    const warmPercent = Math.round(blend.warmWeight * 100);
    details.push({
      label: 'Matrix blend',
      value:
        `${warmPercent}% ${blend.warmName} (${blend.warmKelvin} K) · ` +
        `${100 - warmPercent}% ${blend.coolName} (${blend.coolKelvin} K)`,
    });
  }
  if (solve.iterations > 0) {
    details.push({ label: 'Solve passes', value: String(solve.iterations) });
  }

  return {
    mode: 'raw',
    kelvin: corrected.kelvin,
    tint: corrected.tint,
    rawKelvin: measurement.kelvin,
    rawTint: adobe.tint,
    duv: measurement.duv,
    xy: solve.xy,
    calibrated: corrected.calibrated,
    extrapolated: corrected.extrapolated,
    profileName: corrected.profileName,
    profileId: profile?.id ?? null,
    source: solve.source,
    feature: null,
    warnings,
    details,
    createdAt: Date.now(),
  };
}

export interface LiveInput {
  readonly features: FeatureResult;
  /** Standard deviation of the warmth feature over the recent window. */
  readonly featureSpread: number;
  readonly stabilityReady: boolean;
}

/** Reading from the live camera. */
export function readingFromLive(
  input: LiveInput,
  profile: CalibrationProfile | null,
): Reading {
  const { features } = input;
  const warnings: Warning[] = [];

  const clipping = features.problems.filter((problem) => problem.problem === 'clipping');
  const dark = features.problems.filter((problem) => problem.problem === 'too-dark');
  const missing = features.problems.filter(
    (problem) => problem.problem === 'missing-patch' || problem.problem === 'no-pixels',
  );

  // Order matters: `blockingWarning` shows the first blocking warning, and
  // this one is a precondition rather than a complaint about the frame. Told
  // to "angle the card away from the light" first, someone who owns no card
  // and has never calibrated is being given advice they cannot act on for a
  // problem that is not the one stopping them.
  const hasCurve = (profile?.points.length ?? 0) >= 2;
  if (!hasCurve) {
    warnings.push({
      kind: 'NO CALIBRATION',
      detail:
        profile === null
          ? 'Live mode needs a colour checker card and a calibration profile before it can report a temperature. Use IMPORT RAW instead if you do not have a card.'
          : `"${profile.name}" needs at least two calibration points before it can report a temperature.`,
      blocking: true,
    });
  }

  if (clipping.length > 0) {
    const subject = describeRoles(clipping.map((p) => p.role));
    warnings.push({
      kind: 'CLIPPING',
      detail: `${subject.text} ${subject.verb} blown out. Move away from the light, or angle the card away from it.`,
      blocking: true,
    });
  }
  if (dark.length > 0) {
    const subject = describeRoles(dark.map((p) => p.role));
    warnings.push({
      kind: 'TOO DARK',
      detail: `${subject.text} ${subject.verb} below 10% of range, which leaves too little signal to take a ratio from.`,
      blocking: true,
    });
  }
  if (missing.length > 0) {
    const subject = describeRoles(missing.map((p) => p.role));
    warnings.push({
      kind: 'ALIGN CARD',
      detail: `${subject.text} ${subject.verb} not readable. Line the guide boxes up with the patches named below.`,
      blocking: true,
    });
  }

  const corrected = applyCalibration(profile, {
    kelvin: Number.NaN,
    tint: Number.NaN,
    feature: features.warmth,
  });

  // Convert the feature spread into the Kelvin spread it implies, which is the
  // number that actually tells the user whether to trust the reading.
  let kelvinSpread = Number.NaN;
  if (hasCurve && input.stabilityReady && Number.isFinite(input.featureSpread)) {
    const low = applyCalibration(profile, {
      kelvin: Number.NaN,
      tint: Number.NaN,
      feature: features.warmth - input.featureSpread,
    });
    const high = applyCalibration(profile, {
      kelvin: Number.NaN,
      tint: Number.NaN,
      feature: features.warmth + input.featureSpread,
    });
    kelvinSpread = Math.abs(high.kelvin - low.kelvin) / 2;
    if (kelvinSpread > 300) {
      warnings.push({
        kind: 'UNSTABLE',
        detail: `The reading is swinging by about ±${Math.round(kelvinSpread)} K. Hold still, and check nothing is moving in frame.`,
        blocking: false,
      });
    }
  }

  if (corrected.extrapolated) {
    warnings.push({
      kind: 'OUT OF RANGE',
      detail:
        'This light is outside the range the profile was calibrated over, so the reading is an extrapolation.',
      blocking: false,
    });
  }

  const tint = Number.isFinite(features.greenness)
    ? features.greenness * LIVE_TINT_SCALE + (profile?.tintOffset ?? 0)
    : Number.NaN;

  const details: DetailRow[] = [
    { label: 'Method', value: 'Inter-patch ratio (AWB invariant)' },
    { label: 'Warmth feature', value: formatSignedFixed(features.warmth, 4) },
    { label: 'Green feature', value: formatSignedFixed(features.greenness, 4) },
  ];
  if (Number.isFinite(kelvinSpread)) {
    details.push({ label: 'Frame-to-frame spread', value: `±${Math.round(kelvinSpread)} K` });
  }
  if (Number.isFinite(corrected.kelvin)) {
    details.push({ label: 'Mired', value: formatMired(kelvinToMired(corrected.kelvin)) });
  }

  return {
    mode: 'live',
    kelvin: corrected.kelvin,
    tint,
    rawKelvin: Number.NaN,
    rawTint: Number.NaN,
    duv: Number.NaN,
    xy: { x: Number.NaN, y: Number.NaN },
    calibrated: corrected.calibrated && hasCurve,
    extrapolated: corrected.extrapolated,
    profileName: corrected.profileName,
    profileId: profile?.id ?? null,
    source: 'Live inter-patch ratio',
    feature: Number.isFinite(features.warmth) ? features.warmth : null,
    warnings,
    details,
    createdAt: Date.now(),
  };
}

/**
 * Live mode's green feature is an arbitrary log ratio, not an Adobe tint. This
 * scale is a placeholder that puts a typical fluorescent cast in the right
 * ballpark on the slider; the honest correction is the per-profile tint offset
 * the user calibrates.
 */
export const LIVE_TINT_SCALE = 40;

/**
 * Names the offending patches as a sentence subject, with the verb that
 * agrees with it. Warnings are the text a user reads when something is
 * wrong, and "The green patch blown out" reads like a fault in the app.
 */
function describeRoles(roles: readonly string[]): { text: string; verb: string } {
  const unique = [...new Set(roles)];
  if (unique.length === 1) {
    return { text: `The ${unique[0]} patch`, verb: 'is' };
  }
  const joined =
    unique.length === 2
      ? `${unique[0]} and ${unique[1]}`
      : `${unique.slice(0, -1).join(', ')} and ${unique[unique.length - 1]}`;
  return { text: `The ${joined} patches`, verb: 'are' };
}

function formatSignedFixed(value: number, digits: number): string {
  if (!Number.isFinite(value)) return '—';
  return `${value >= 0 ? '+' : '−'}${Math.abs(value).toFixed(digits)}`;
}
