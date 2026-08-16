/**
 * Chromaticity coordinate conversions.
 *
 * Two spaces are used throughout:
 *   - CIE 1931 xy      — what DNG metadata and most tools speak.
 *   - CIE 1960 UCS uv  — where the Planckian locus, CCT and Duv are defined.
 *
 * Note that CIE 1960 v is NOT CIE 1976 v'. The relationship is v' = 1.5 v.
 * Everything in this app that says `uv` means CIE 1960 UCS. Getting these two
 * mixed up silently scales Duv by 1.5, so the naming is deliberately explicit.
 */

import type { Vec3 } from './matrix.ts';

export interface XY {
  readonly x: number;
  readonly y: number;
}

export interface UV {
  readonly u: number;
  readonly v: number;
}

/** CIE 1931 XYZ tristimulus -> xy chromaticity. */
export function xyzToXY(xyz: Vec3): XY {
  const sum = xyz[0] + xyz[1] + xyz[2];
  if (!Number.isFinite(sum) || sum <= 0) {
    throw new Error('XYZ has non-positive sum; chromaticity is undefined');
  }
  return { x: xyz[0] / sum, y: xyz[1] / sum };
}

/** xy chromaticity -> XYZ normalised to Y = 1. */
export function xyToXYZ(xy: XY, luminance = 1): Vec3 {
  if (xy.y === 0) throw new Error('xy with y = 0 has no finite XYZ');
  const scale = luminance / xy.y;
  return [xy.x * scale, luminance, (1 - xy.x - xy.y) * scale];
}

/** CIE 1931 xy -> CIE 1960 UCS uv. */
export function xyToUV(xy: XY): UV {
  const denom = -2 * xy.x + 12 * xy.y + 3;
  if (denom === 0) throw new Error('xy lies on the uv singular line');
  return { u: (4 * xy.x) / denom, v: (6 * xy.y) / denom };
}

/** CIE 1960 UCS uv -> CIE 1931 xy. */
export function uvToXY(uv: UV): XY {
  const denom = 2 * uv.u - 8 * uv.v + 4;
  if (denom === 0) throw new Error('uv lies on the xy singular line');
  return { x: (3 * uv.u) / denom, y: (2 * uv.v) / denom };
}

/** CIE 1931 XYZ -> CIE 1960 UCS uv, without the round trip through xy. */
export function xyzToUV(xyz: Vec3): UV {
  const denom = xyz[0] + 15 * xyz[1] + 3 * xyz[2];
  if (!Number.isFinite(denom) || denom <= 0) {
    throw new Error('XYZ has non-positive uv denominator');
  }
  return { u: (4 * xyz[0]) / denom, v: (6 * xyz[1]) / denom };
}

/** Reciprocal colour temperature. Mired = micro reciprocal degrees = 1e6 / K. */
export function kelvinToMired(kelvin: number): number {
  if (kelvin <= 0) throw new Error('Kelvin must be positive');
  return 1e6 / kelvin;
}

export function miredToKelvin(mired: number): number {
  if (mired <= 0) throw new Error('Mired must be positive');
  return 1e6 / mired;
}

