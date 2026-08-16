/**
 * Calibration profiles.
 *
 * A profile is bound to one specific combination of measurement mode, capture
 * app and reference card. A ProRAW profile and a Lightroom-DNG profile are
 * different cameras as far as the numbers are concerned, and a calibration
 * fitted against a ColorChecker Passport says nothing about a SpyderCheckr.
 * Mixing them silently is worse than having no calibration at all, so profiles
 * never merge and the active one is always named on screen.
 */

import { kelvinToMired, miredToKelvin } from '../color/index.ts';
import type { MeasurementMode } from '../color/index.ts';
import {
  type CurvePoint,
  curveResiduals,
  evaluateCurve,
  prepareKnots,
} from './curve.ts';

export interface CalibrationPoint {
  readonly id: string;
  /** What the app measured, before correction. Mired for raw, feature units for live. */
  readonly measured: number;
  /** The reference source's known CCT, in Kelvin. */
  readonly referenceKelvin: number;
  /** Measured tint, before correction. */
  readonly measuredTint: number;
  /** The reference source's known tint, usually 0 for a blackbody-like source. */
  readonly referenceTint: number;
  readonly label: string;
  readonly createdAt: number;
}

export interface CalibrationProfile {
  readonly id: string;
  readonly name: string;
  readonly mode: MeasurementMode;
  /** Free text: which camera app, which reference card, which phone. */
  readonly notes: string;
  /** Named reference card for live mode; null for raw. */
  readonly cardId: string | null;
  readonly points: readonly CalibrationPoint[];
  /** Single-point field trim, in mired. Applied on top of the curve. */
  readonly miredTrim: number;
  /** Independent tint offset, in Adobe tint units. */
  readonly tintOffset: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface CorrectionResult {
  readonly kelvin: number;
  readonly tint: number;
  /** False when the profile has no usable points and no trim. */
  readonly calibrated: boolean;
  /** Reading fell outside the span of the calibration points. */
  readonly extrapolated: boolean;
  readonly profileName: string | null;
}

export function createProfile(
  init: Pick<CalibrationProfile, 'name' | 'mode'> & Partial<CalibrationProfile>,
): CalibrationProfile {
  const now = Date.now();
  return {
    id: init.id ?? newId('prof'),
    name: init.name,
    mode: init.mode,
    notes: init.notes ?? '',
    cardId: init.cardId ?? null,
    points: init.points ?? [],
    miredTrim: init.miredTrim ?? 0,
    tintOffset: init.tintOffset ?? 0,
    createdAt: init.createdAt ?? now,
    updatedAt: init.updatedAt ?? now,
  };
}

export function newId(prefix: string): string {
  const random =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return `${prefix}_${Date.now().toString(36)}_${random}`;
}

/**
 * Knots for the temperature correction curve, in mired.
 *
 * For raw mode the x axis is measured mired and the y axis is reference
 * mired, so an uncalibrated instrument would give y = x.
 *
 * For live mode the x axis is the AWB-invariant feature value and y is
 * reference mired, which has no identity baseline at all.
 */
export function temperatureKnots(profile: CalibrationProfile): CurvePoint[] {
  return prepareKnots(
    profile.points.map((point) => ({
      x: point.measured,
      y: kelvinToMired(point.referenceKelvin),
    })),
  );
}

/**
 * Live mode's feature runs the other way round from mired: a larger feature
 * value means warmer light, which means larger mired. Raw mode is already
 * monotonically increasing. Both end up non-decreasing, which is what the
 * isotonic fit requires.
 */
export function extrapolationFor(mode: MeasurementMode): 'flat' | 'slope' {
  // Raw mode holds the last known correction, which is the safe behaviour
  // when the correction is a small delta on an already-good reading. Live
  // mode has no baseline to hold, so flat would collapse every out-of-range
  // reading onto a single temperature; it continues the end slope instead and
  // the reading is flagged as extrapolated.
  return mode === 'raw' ? 'flat' : 'slope';
}

/** Apply a profile to a raw measurement. */
export function applyCalibration(
  profile: CalibrationProfile | null,
  measured: { kelvin: number; tint: number; feature?: number },
): CorrectionResult {
  if (!profile) {
    return {
      kelvin: measured.kelvin,
      tint: measured.tint,
      calibrated: false,
      extrapolated: false,
      profileName: null,
    };
  }

  const knots = temperatureKnots(profile);
  const extrapolation = extrapolationFor(profile.mode);

  // Live mode drives the curve from its feature value; raw mode drives it
  // from the measured mired.
  const input =
    profile.mode === 'live'
      ? (measured.feature ?? Number.NaN)
      : kelvinToMired(measured.kelvin);

  let mired: number;
  let extrapolated = false;

  if (knots.length === 0) {
    // No fitted points. Raw mode still has a usable reading to trim; live mode
    // has nothing at all, because its feature is not a temperature.
    if (profile.mode === 'live') {
      return {
        kelvin: Number.NaN,
        tint: Number.NaN,
        calibrated: false,
        extrapolated: false,
        profileName: profile.name,
      };
    }
    mired = kelvinToMired(measured.kelvin);
  } else if (!Number.isFinite(input)) {
    return {
      kelvin: Number.NaN,
      tint: Number.NaN,
      calibrated: false,
      extrapolated: false,
      profileName: profile.name,
    };
  } else if (knots.length === 1 && profile.mode === 'raw') {
    // A single point is an offset, not a curve: shift by the residual the
    // one measurement showed, rather than reporting that temperature for
    // every reading.
    const only = knots[0]!;
    mired = kelvinToMired(measured.kelvin) + (only.y - only.x);
  } else {
    const evaluated = evaluateCurve(knots, input, extrapolation);
    mired = evaluated.value;
    extrapolated = evaluated.extrapolated;
  }

  mired += profile.miredTrim;

  const hasCorrection =
    knots.length > 0 || profile.miredTrim !== 0 || profile.tintOffset !== 0;

  if (!(mired > 0) || !Number.isFinite(mired)) {
    return {
      kelvin: Number.NaN,
      tint: Number.NaN,
      calibrated: hasCorrection,
      extrapolated: true,
      profileName: profile.name,
    };
  }

  return {
    kelvin: miredToKelvin(mired),
    tint: measured.tint + profile.tintOffset,
    calibrated: hasCorrection,
    extrapolated,
    profileName: profile.name,
  };
}

/**
 * Single-point field trim: "this light is actually N K".
 *
 * Returns the profile with a mired offset that makes the current reading
 * report the stated temperature. Expressed in mired so the same trim behaves
 * consistently at both ends of the range — a +100 K trim at 2700 K is a very
 * different correction from +100 K at 6500 K, but a -12 mired trim is the
 * same perceptual step everywhere.
 */
export function withFieldTrim(
  profile: CalibrationProfile,
  currentReadingKelvin: number,
  actualKelvin: number,
): CalibrationProfile {
  if (!(currentReadingKelvin > 0) || !(actualKelvin > 0)) return profile;
  const delta = kelvinToMired(actualKelvin) - kelvinToMired(currentReadingKelvin);
  return {
    ...profile,
    miredTrim: profile.miredTrim + delta,
    updatedAt: Date.now(),
  };
}

export function withTintOffset(
  profile: CalibrationProfile,
  currentTint: number,
  actualTint: number,
): CalibrationProfile {
  return {
    ...profile,
    tintOffset: profile.tintOffset + (actualTint - currentTint),
    updatedAt: Date.now(),
  };
}

export function addPoint(
  profile: CalibrationProfile,
  point: Omit<CalibrationPoint, 'id' | 'createdAt'>,
): CalibrationProfile {
  return {
    ...profile,
    points: [...profile.points, { ...point, id: newId('pt'), createdAt: Date.now() }],
    updatedAt: Date.now(),
  };
}

export function removePoint(profile: CalibrationProfile, pointId: string): CalibrationProfile {
  return {
    ...profile,
    points: profile.points.filter((point) => point.id !== pointId),
    updatedAt: Date.now(),
  };
}

export function clearTrim(profile: CalibrationProfile): CalibrationProfile {
  return { ...profile, miredTrim: 0, tintOffset: 0, updatedAt: Date.now() };
}

/** Per-point residual in Kelvin, for the calibration screen's error column. */
export interface PointResidual {
  readonly point: CalibrationPoint;
  /** Residual in mired, the space the fit happens in. */
  readonly miredResidual: number;
  /** The same residual expressed in Kelvin at that point, for readability. */
  readonly kelvinResidual: number;
}

export function profileResiduals(profile: CalibrationProfile): PointResidual[] {
  const points = profile.points.map((point) => ({
    x: point.measured,
    y: kelvinToMired(point.referenceKelvin),
  }));
  const residuals = curveResiduals(points, extrapolationFor(profile.mode));

  return profile.points.map((point, index) => {
    const miredResidual = residuals[index] ?? 0;
    const referenceMired = kelvinToMired(point.referenceKelvin);
    const fittedMired = referenceMired + miredResidual;
    const kelvinResidual =
      fittedMired > 0 ? miredToKelvin(fittedMired) - point.referenceKelvin : Number.NaN;
    return { point, miredResidual, kelvinResidual };
  });
}

/** Tint correction is a plain average offset — there is no evidence it varies with CCT. */
export function fitTintOffset(profile: CalibrationProfile): number {
  if (profile.points.length === 0) return 0;
  const total = profile.points.reduce(
    (sum, point) => sum + (point.referenceTint - point.measuredTint),
    0,
  );
  return total / profile.points.length;
}
