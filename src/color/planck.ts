/**
 * Planckian (blackbody) locus and the CIE daylight locus.
 *
 * The Planckian locus is computed from first principles: Planck's law
 * integrated against the CIE 1931 2-degree observer. This is what Duv is
 * measured against, and it doubles as an independent check on the Robertson
 * isotemperature table (see planck.test.ts).
 */

import type { UV, XY } from './chromaticity.ts';
import { xyzToUV, xyzToXY } from './chromaticity.ts';
import { CMF_SAMPLE_COUNT, cmfAt, cmfWavelength } from './cmf.ts';
import type { Vec3 } from './matrix.ts';

/** First radiation constant, W m^2 (CODATA 2018). */
export const PLANCK_C1 = 3.741771852e-16;
/** Second radiation constant, m K (CODATA 2018 / ITS-90). */
export const PLANCK_C2 = 1.4387768775e-2;
/**
 * The value of c2 in force when Robertson's isotemperature table was
 * computed. Only needed to compare against that table on equal terms.
 */
export const PLANCK_C2_1931 = 1.4380e-2;

/** Spectral radiant exitance of a blackbody at wavelength (nm) and temperature (K). */
export function planckSpectralRadiance(
  wavelengthNm: number,
  kelvin: number,
  c2 = PLANCK_C2,
): number {
  const lambda = wavelengthNm * 1e-9;
  const l5 = lambda * lambda * lambda * lambda * lambda;
  return PLANCK_C1 / (l5 * Math.expm1(c2 / (lambda * kelvin)));
}

/** CIE XYZ of a Planckian radiator, normalised so Y = 1. */
export function planckianXYZ(kelvin: number, c2 = PLANCK_C2): Vec3 {
  if (!(kelvin > 0)) throw new Error('Planckian temperature must be positive');
  let x = 0;
  let y = 0;
  let z = 0;
  for (let i = 0; i < CMF_SAMPLE_COUNT; i++) {
    const power = planckSpectralRadiance(cmfWavelength(i), kelvin, c2);
    const [xb, yb, zb] = cmfAt(i);
    x += power * xb;
    y += power * yb;
    z += power * zb;
  }
  if (y <= 0) throw new Error('Planckian integration produced zero luminance');
  return [x / y, 1, z / y];
}

export function planckianXY(kelvin: number, c2 = PLANCK_C2): XY {
  return xyzToXY(planckianXYZ(kelvin, c2));
}

export function planckianUV(kelvin: number, c2 = PLANCK_C2): UV {
  return xyzToUV(planckianXYZ(kelvin, c2));
}

/**
 * CIE D-series daylight locus, 4000 K .. 25000 K.
 *
 * This is the standard cubic from CIE 15:2004. Outside that span the CIE
 * does not define a daylight illuminant at all, so this throws rather than
 * extrapolating a polynomial into nonsense.
 */
export function daylightXY(kelvin: number): XY {
  if (kelvin < 4000 || kelvin > 25000) {
    throw new Error(`Daylight locus is only defined for 4000-25000 K, got ${kelvin}`);
  }
  const t = kelvin;
  const t2 = t * t;
  const t3 = t2 * t;
  const x =
    t <= 7000
      ? -4.607e9 / t3 + 2.9678e6 / t2 + 0.09911e3 / t + 0.244063
      : -2.0064e9 / t3 + 1.9018e6 / t2 + 0.24748e3 / t + 0.23704;
  const y = -3.0 * x * x + 2.87 * x - 0.275;
  return { x, y };
}

