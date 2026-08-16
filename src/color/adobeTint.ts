/**
 * Adobe-compatible Temperature / Tint.
 *
 * This is the pair of numbers Lightroom, Camera Raw, DxO PhotoLab and
 * Affinity Photo put on their white balance sliders. It is a different
 * parameterisation of the same chromaticity as CCT + Duv, and it is the one
 * that transfers into a raw converter without arithmetic.
 *
 * The algorithm is Adobe's `dng_temperature` from the DNG SDK, working off
 * the same Robertson isotemperature table: walk down the lines until the
 * sample falls below one, interpolate the temperature between the bracketing
 * pair, then project the residual onto the interpolated isotherm direction
 * and scale it. The scale factor of -3000 is Adobe's, and it is what makes
 * the numbers agree with the sliders.
 *
 * Sign convention matches the sliders: positive tint is magenta, negative is
 * green. A green source therefore reads as positive tint, because positive
 * tint is the magenta correction that cancels it.
 */

import type { XY } from './chromaticity.ts';
import { ROBERTSON_TABLE } from './robertson.ts';

/** Adobe's tint scale factor. */
export const TINT_SCALE = -3000;
export const TINT_MIN = -150;
export const TINT_MAX = 150;

export interface TemperatureTint {
  readonly kelvin: number;
  readonly tint: number;
  /** Tint hit the -150..150 slider limit and no longer describes the light. */
  readonly tintClipped: boolean;
}

/** CIE 1931 xy -> Adobe Temperature / Tint. */
export function xyToTemperatureTint(xy: XY): TemperatureTint {
  const table = ROBERTSON_TABLE;
  const denom = 1.5 - xy.x + 6 * xy.y;
  if (denom === 0) throw new Error('xy lies on the uv singular line');
  // Identical to the CIE 1960 UCS transform, written the way the DNG SDK does.
  const u = (2 * xy.x) / denom;
  const v = (3 * xy.y) / denom;

  let lastDistance = 0;
  let lastDu = 0;
  let lastDv = 0;

  for (let index = 1; index < table.length; index++) {
    const line = table[index]!;

    // Unit vector along this isotemperature line.
    const length = Math.sqrt(1 + line.t * line.t);
    let du = 1 / length;
    let dv = line.t / length;

    const uu = u - line.u;
    const vv = v - line.v;

    // Signed distance above (positive) or below (negative) the line.
    let distance = -uu * dv + vv * du;

    const isLast = index === table.length - 1;
    if (distance <= 0 || isLast) {
      if (distance > 0) distance = 0;
      distance = -distance;

      const fraction = index === 1 ? 0 : distance / (lastDistance + distance);

      const previous = table[index - 1]!;
      const kelvin =
        1e6 / (previous.r * fraction + line.r * (1 - fraction));

      // Offset from the interpolated point on the locus.
      const ou = u - (previous.u * fraction + line.u * (1 - fraction));
      const ov = v - (previous.v * fraction + line.v * (1 - fraction));

      // Interpolate the isotherm direction across the same pair.
      du = du * (1 - fraction) + lastDu * fraction;
      dv = dv * (1 - fraction) + lastDv * fraction;
      const norm = Math.hypot(du, dv);
      du /= norm;
      dv /= norm;

      const rawTint = (ou * du + ov * dv) * TINT_SCALE;
      const tint = Math.min(TINT_MAX, Math.max(TINT_MIN, rawTint));
      return { kelvin, tint, tintClipped: rawTint !== tint };
    }

    lastDistance = distance;
    lastDu = du;
    lastDv = dv;
  }

  throw new Error('Chromaticity is outside the range the temperature table covers');
}

/** Adobe Temperature / Tint -> CIE 1931 xy. */
export function temperatureTintToXY(kelvin: number, tint: number): XY {
  const table = ROBERTSON_TABLE;
  const r = 1e6 / kelvin;
  const offset = tint / TINT_SCALE;

  for (let index = 0; index < table.length - 1; index++) {
    const current = table[index]!;
    const next = table[index + 1]!;
    const isLast = index === table.length - 2;
    if (r >= next.r && !isLast) continue;

    const fraction = (next.r - r) / (next.r - current.r);

    const u0 = current.u * fraction + next.u * (1 - fraction);
    const v0 = current.v * fraction + next.v * (1 - fraction);

    const len1 = Math.sqrt(1 + current.t * current.t);
    const len2 = Math.sqrt(1 + next.t * next.t);
    const du1 = 1 / len1;
    const dv1 = current.t / len1;
    const du2 = 1 / len2;
    const dv2 = next.t / len2;

    let du = du1 * fraction + du2 * (1 - fraction);
    let dv = dv1 * fraction + dv2 * (1 - fraction);
    const norm = Math.hypot(du, dv);
    du /= norm;
    dv /= norm;

    const u = u0 + du * offset;
    const v = v0 + dv * offset;

    const denom = u - 4 * v + 2;
    if (denom === 0) throw new Error('Interpolated uv lies on the xy singular line');
    return { x: (1.5 * u) / denom, y: v / denom };
  }

  throw new Error('Temperature is outside the range the temperature table covers');
}
