/**
 * Duv — signed distance from the Planckian locus in CIE 1960 UCS.
 *
 * Sign convention follows ANSI C78.377 and CIE 15: positive Duv is above the
 * locus (green), negative is below (magenta/pink). Fluorescent and many cheap
 * LED sources sit noticeably positive; that green cast is exactly what a tint
 * correction has to undo.
 */

import type { UV, XY } from './chromaticity.ts';
import { xyToUV } from './chromaticity.ts';
import { planckianUV } from './planck.ts';
import { uvToCCT } from './robertson.ts';

/**
 * Beyond this distance from the locus the notion of a correlated colour
 * temperature stops being meaningful (CIE 15 / Ohno 2011 both draw the line
 * at 0.05). Readings past it are reported but flagged.
 */
export const DUV_VALIDITY_LIMIT = 0.05;

export interface Measurement {
  readonly kelvin: number;
  readonly duv: number;
  readonly xy: XY;
  readonly uv: UV;
  /** CCT fell outside the range Robertson's table resolves. */
  readonly cctOutOfRange: boolean;
  /** |Duv| exceeds 0.05, so CCT does not describe this light well. */
  readonly farFromLocus: boolean;
}

/** Signed distance from the Planckian locus at a known CCT. */
export function duvFromUV(uv: UV, kelvin: number): number {
  const locus = planckianUV(kelvin);
  const du = uv.u - locus.u;
  const dv = uv.v - locus.v;
  return Math.sign(dv) * Math.hypot(du, dv);
}

/** Full CCT + Duv measurement from a CIE 1960 UCS coordinate. */
export function measureUV(uv: UV): Measurement {
  const cct = uvToCCT(uv);
  const duv = duvFromUV(uv, cct.kelvin);
  return {
    kelvin: cct.kelvin,
    duv,
    xy: uvToXYSafe(uv),
    uv,
    cctOutOfRange: cct.outOfRange,
    farFromLocus: Math.abs(duv) > DUV_VALIDITY_LIMIT,
  };
}

/** Full CCT + Duv measurement from a CIE 1931 xy coordinate. */
export function measureXY(xy: XY): Measurement {
  const uv = xyToUV(xy);
  const cct = uvToCCT(uv);
  const duv = duvFromUV(uv, cct.kelvin);
  return {
    kelvin: cct.kelvin,
    duv,
    xy,
    uv,
    cctOutOfRange: cct.outOfRange,
    farFromLocus: Math.abs(duv) > DUV_VALIDITY_LIMIT,
  };
}

function uvToXYSafe(uv: UV): XY {
  const denom = 2 * uv.u - 8 * uv.v + 4;
  if (denom === 0) return { x: NaN, y: NaN };
  return { x: (3 * uv.u) / denom, y: (2 * uv.v) / denom };
}
