/**
 * sRGB transfer function and primaries.
 *
 * Every pixel that arrives from a `<video>` frame or a `<canvas>` readback has
 * already been through the sRGB encoding curve. Averaging or ratioing those
 * values directly is meaningless — the curve has to come off first, which is
 * what `srgbToLinear` is for. This matters more than it sounds: the encoding
 * gamma of ~2.2 turns a true 2:1 radiance ratio into a 1.4:1 code-value ratio.
 */

import type { Mat3, Vec3 } from './matrix.ts';
import type { XY } from './chromaticity.ts';
import { xyzToXY } from './chromaticity.ts';

/**
 * sRGB electro-optical transfer function: encoded [0,1] -> linear [0,1].
 *
 * The two branch points published in IEC 61966-2-1 (0.04045 encoded and
 * 0.0031308 linear) are rounded independently and are not exact inverses of
 * each other, so a round trip through both functions can land about 3e-8
 * away from where it started. That is four orders of magnitude below 8-bit
 * quantisation and is a property of the standard, not of this code.
 */
export function srgbToLinear(value: number): number {
  if (!(value > 0)) return 0;
  if (value >= 1) return 1;
  return value <= 0.04045 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);
}

/** Inverse of `srgbToLinear`. Output is clamped to [0,1]. */
export function linearToSrgb(value: number): number {
  if (!(value > 0)) return 0;
  if (value >= 1) return 1;
  return value <= 0.0031308 ? value * 12.92 : 1.055 * Math.pow(value, 1 / 2.4) - 0.055;
}

/** 256-entry lookup for 8-bit pixel data, built once. */
export const SRGB_DECODE_LUT: Readonly<Float64Array> = (() => {
  const lut = new Float64Array(256);
  for (let i = 0; i < 256; i++) lut[i] = srgbToLinear(i / 255);
  return lut;
})();

/** Linear sRGB -> CIE XYZ (D65 white point), IEC 61966-2-1. */
export const LINEAR_SRGB_TO_XYZ_D65: Mat3 = [
  0.4123907992659595, 0.3575843393838780, 0.1804807884018343,
  0.2126390058715104, 0.7151686787677559, 0.0721923153607337,
  0.0193308187155918, 0.1191947797946259, 0.9505321522496608,
];

export const XYZ_D65_TO_LINEAR_SRGB: Mat3 = [
  3.2409699419045213, -1.5373831775700935, -0.4986107602930033,
  -0.9692436362808798, 1.8759675015077206, 0.0415550574071756,
  0.0556300796969936, -0.2039769588889765, 1.0569715142428786,
];

/**
 * Chromaticity of a linear sRGB triple, interpreted as a D65-referred colour.
 *
 * This is only meaningful for a frame whose white balance has NOT been
 * altered — which is never true of an iOS camera frame. It exists for tests
 * and for interpreting deliberately-constructed colours, not for measuring
 * ambient light. Live mode uses channel ratios instead, for exactly this
 * reason.
 */
export function linearSrgbToXY(rgb: Vec3): XY {
  const m = LINEAR_SRGB_TO_XYZ_D65;
  const xyz: Vec3 = [
    m[0] * rgb[0] + m[1] * rgb[1] + m[2] * rgb[2],
    m[3] * rgb[0] + m[4] * rgb[1] + m[5] * rgb[2],
    m[6] * rgb[0] + m[7] * rgb[1] + m[8] * rgb[2],
  ];
  return xyzToXY(xyz);
}
