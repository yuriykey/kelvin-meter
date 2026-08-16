import { describe, expect, it } from 'vitest';
import {
  IDENTITY3,
  determinant,
  invert,
  mat3,
  matAddScaled,
  matMul,
  matMulVec,
  vec3,
} from './matrix.ts';
import { LINEAR_SRGB_TO_XYZ_D65, XYZ_D65_TO_LINEAR_SRGB, linearToSrgb, srgbToLinear, SRGB_DECODE_LUT } from './srgb.ts';

describe('3x3 matrix maths', () => {
  const m = mat3([0.5, 0.2, 0.1, 0.3, 0.9, 0.05, 0.02, 0.1, 0.8]);

  it('inverts to identity', () => {
    const product = matMul(m, invert(m));
    for (let i = 0; i < 9; i++) {
      expect(product[i]).toBeCloseTo(IDENTITY3[i]!, 12);
    }
  });

  it('inverts the sRGB primaries matrix to the published inverse', () => {
    const computed = invert(LINEAR_SRGB_TO_XYZ_D65);
    for (let i = 0; i < 9; i++) {
      expect(computed[i]).toBeCloseTo(XYZ_D65_TO_LINEAR_SRGB[i]!, 9);
    }
  });

  it('maps linear sRGB white to the D65 white point', () => {
    const white = matMulVec(LINEAR_SRGB_TO_XYZ_D65, vec3([1, 1, 1]));
    const sum = white[0] + white[1] + white[2];
    expect(white[0] / sum).toBeCloseTo(0.3127, 3);
    expect(white[1] / sum).toBeCloseTo(0.329, 3);
  });

  it('refuses to invert a singular matrix', () => {
    expect(() => invert(mat3([1, 2, 3, 2, 4, 6, 7, 8, 9]))).toThrow(/singular/i);
  });

  it('computes determinants', () => {
    expect(determinant(IDENTITY3)).toBeCloseTo(1, 12);
    expect(determinant(mat3([2, 0, 0, 0, 3, 0, 0, 0, 4]))).toBeCloseTo(24, 12);
  });

  it('blends two matrices by weight', () => {
    const a = mat3([1, 1, 1, 1, 1, 1, 1, 1, 1]);
    const b = mat3([3, 3, 3, 3, 3, 3, 3, 3, 3]);
    const blended = matAddScaled(a, 0.25, b, 0.75);
    for (let i = 0; i < 9; i++) expect(blended[i]).toBeCloseTo(2.5, 12);
  });

  it('rejects wrong-sized inputs', () => {
    expect(() => mat3([1, 2, 3])).toThrow();
    expect(() => vec3([1, 2])).toThrow();
  });
});

describe('sRGB transfer function', () => {
  it('round-trips to well inside 8-bit quantisation', () => {
    // Not exact: the standard's encoded and linear breakpoints are rounded
    // independently, so 0.04045 comes back 3e-8 low. One 8-bit code step is
    // 0.0039, so this is irrelevant in practice but worth pinning down.
    for (const v of [0, 0.01, 0.04045, 0.2, 0.5, 0.8, 1]) {
      expect(Math.abs(linearToSrgb(srgbToLinear(v)) - v)).toBeLessThan(1e-6);
    }
  });

  it('round-trips exactly away from the breakpoint', () => {
    for (const v of [0, 0.2, 0.5, 0.8, 1]) {
      expect(linearToSrgb(srgbToLinear(v))).toBeCloseTo(v, 12);
    }
  });

  it('handles NaN by treating it as black rather than propagating it', () => {
    expect(srgbToLinear(NaN)).toBe(0);
    expect(linearToSrgb(NaN)).toBe(0);
  });

  it('matches the piecewise definition at the breakpoint', () => {
    expect(srgbToLinear(0.04045)).toBeCloseTo(0.04045 / 12.92, 12);
    expect(srgbToLinear(0.5)).toBeCloseTo(0.21404114048223255, 12);
  });

  it('clamps out-of-range input rather than producing NaN', () => {
    expect(srgbToLinear(-1)).toBe(0);
    expect(srgbToLinear(2)).toBe(1);
    expect(linearToSrgb(-1)).toBe(0);
    expect(linearToSrgb(2)).toBe(1);
  });

  it('has a lookup table consistent with the function', () => {
    expect(SRGB_DECODE_LUT.length).toBe(256);
    for (const code of [0, 1, 10, 128, 200, 255]) {
      expect(SRGB_DECODE_LUT[code]).toBeCloseTo(srgbToLinear(code / 255), 12);
    }
  });

  it('is not a pure 2.2 power law, which is why ratios need it removed', () => {
    // Half code value is ~21% of linear light, not 50% and not 21.8%.
    expect(srgbToLinear(0.5)).toBeLessThan(0.25);
    expect(Math.abs(srgbToLinear(0.5) - Math.pow(0.5, 2.2))).toBeGreaterThan(0.002);
  });
});
