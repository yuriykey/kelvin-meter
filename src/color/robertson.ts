/**
 * Robertson's method for correlated colour temperature.
 *
 * McCamy's cubic approximation is deliberately NOT used: it is fitted around
 * daylight and drifts badly below ~2500 K and above ~7000 K, which is exactly
 * the span this app lives in (2700 K tungsten-substitute bulbs at one end,
 * 6500 K north-facing window light at the other).
 *
 * The 31-entry isotemperature line table is from Wyszecki & Stiles,
 * "Color Science" 2nd ed., Table 1(3.11). Columns are:
 *   r — reciprocal temperature in mired (1e6 / K), 0 mired = infinite K
 *   u — CIE 1960 UCS u of the Planckian radiator at that temperature
 *   v — CIE 1960 UCS v of the Planckian radiator at that temperature
 *   t — slope dv/du of the isotemperature line through (u, v)
 *
 * The u/v columns of this table are validated against an independent
 * Planckian locus computed from Planck's law and the CIE 1931 2-degree
 * colour matching functions — see planck.test.ts. Two independent sources
 * agreeing to <2e-4 rules out transcription errors in either.
 */

import type { UV, XY } from './chromaticity.ts';
import { xyToUV } from './chromaticity.ts';

export interface IsothermLine {
  /** Reciprocal temperature, mired. */
  readonly r: number;
  readonly u: number;
  readonly v: number;
  /** Slope of the isotemperature line. */
  readonly t: number;
}

export const ROBERTSON_TABLE: readonly IsothermLine[] = [
  { r: 0, u: 0.18006, v: 0.26352, t: -0.24341 },
  { r: 10, u: 0.18066, v: 0.26589, t: -0.25479 },
  { r: 20, u: 0.18133, v: 0.26846, t: -0.26876 },
  { r: 30, u: 0.18208, v: 0.27119, t: -0.28539 },
  { r: 40, u: 0.18293, v: 0.27407, t: -0.3047 },
  { r: 50, u: 0.18388, v: 0.27709, t: -0.32675 },
  { r: 60, u: 0.18494, v: 0.28021, t: -0.35156 },
  { r: 70, u: 0.18611, v: 0.28342, t: -0.37915 },
  { r: 80, u: 0.1874, v: 0.28668, t: -0.40955 },
  { r: 90, u: 0.1888, v: 0.28997, t: -0.44278 },
  { r: 100, u: 0.19032, v: 0.29326, t: -0.47888 },
  { r: 125, u: 0.19462, v: 0.30141, t: -0.58204 },
  { r: 150, u: 0.19962, v: 0.30921, t: -0.70471 },
  { r: 175, u: 0.20525, v: 0.31647, t: -0.84901 },
  { r: 200, u: 0.21142, v: 0.32312, t: -1.0182 },
  { r: 225, u: 0.21807, v: 0.32909, t: -1.2168 },
  { r: 250, u: 0.22511, v: 0.33439, t: -1.4512 },
  { r: 275, u: 0.23247, v: 0.33904, t: -1.7298 },
  { r: 300, u: 0.2401, v: 0.34308, t: -2.0637 },
  { r: 325, u: 0.24792, v: 0.34655, t: -2.4681 },
  { r: 350, u: 0.25591, v: 0.34951, t: -2.9641 },
  { r: 375, u: 0.264, v: 0.352, t: -3.5814 },
  { r: 400, u: 0.27218, v: 0.35407, t: -4.3633 },
  { r: 425, u: 0.28039, v: 0.35577, t: -5.3762 },
  { r: 450, u: 0.28863, v: 0.35714, t: -6.7262 },
  { r: 475, u: 0.29685, v: 0.35823, t: -8.5955 },
  { r: 500, u: 0.30505, v: 0.35907, t: -10.7622 },
  { r: 525, u: 0.3132, v: 0.35968, t: -13.3299 },
  { r: 550, u: 0.32129, v: 0.36011, t: -16.4557 },
  { r: 575, u: 0.32931, v: 0.36038, t: -20.598 },
  { r: 600, u: 0.33724, v: 0.36051, t: -26.718 },
];

/** Coolest temperature the table can resolve (r = 600 mired). */
export const ROBERTSON_MIN_KELVIN = 1e6 / 600;
/** Warmest temperature the table can resolve before r = 0 (infinite K). */
export const ROBERTSON_MAX_KELVIN = 1e6 / 10;

export interface CCTResult {
  /** Correlated colour temperature in Kelvin. */
  readonly kelvin: number;
  /**
   * True when the chromaticity fell outside the 1667 K .. 100000 K span the
   * table covers, in which case `kelvin` is clamped to the nearest endpoint
   * and must not be reported as a measurement.
   */
  readonly outOfRange: boolean;
}

/**
 * CCT from CIE 1960 UCS uv by Robertson's interpolation.
 *
 * Walks the isotemperature lines until the sample crosses from one side to
 * the other, then interpolates in reciprocal-temperature (mired) space using
 * the perpendicular distances to the two bracketing lines.
 */
export function uvToCCT(uv: UV): CCTResult {
  const table = ROBERTSON_TABLE;
  let previousDistance = 0;
  let index = 0;
  let distance = 0;

  for (index = 0; index < table.length; index++) {
    const line = table[index]!;
    distance = uv.v - line.v - line.t * (uv.u - line.u);
    if (index > 0 && signChanged(distance, previousDistance)) break;
    previousDistance = distance;
  }

  if (index === 0) {
    // Sample sits above the first line: hotter than the table resolves.
    return { kelvin: ROBERTSON_MAX_KELVIN, outOfRange: true };
  }
  if (index === table.length) {
    // Never crossed: cooler than 1667 K, or far off the locus entirely.
    return { kelvin: ROBERTSON_MIN_KELVIN, outOfRange: true };
  }

  const current = table[index]!;
  const previous = table[index - 1]!;

  // Normalise both distances to true perpendicular distance before weighting.
  const dCurrent = distance / Math.sqrt(1 + current.t * current.t);
  const dPrevious = previousDistance / Math.sqrt(1 + previous.t * previous.t);

  const fraction = dPrevious / (dPrevious - dCurrent);
  const mired = previous.r + fraction * (current.r - previous.r);

  if (mired <= 0) return { kelvin: ROBERTSON_MAX_KELVIN, outOfRange: true };
  return { kelvin: 1e6 / mired, outOfRange: false };
}

/** CCT from CIE 1931 xy. */
export function xyToCCT(xy: XY): CCTResult {
  return uvToCCT(xyToUV(xy));
}

function signChanged(a: number, b: number): boolean {
  return (a < 0 && b >= 0) || (a >= 0 && b < 0);
}
