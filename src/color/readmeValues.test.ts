import { describe, expect, it } from 'vitest';
import { measureXY } from './duv.ts';
import { formatDuv } from './format.ts';

/**
 * Pins the reference values quoted in the README.
 *
 * Documentation that drifts from the code is worse than no documentation,
 * and these four numbers are the app's claim to being correct at all.
 */
describe('reference values quoted in the README', () => {
  it.each([
    ['D65', 0.3127, 0.329, '6503.7', '+0.0032'],
    ['CIE Illuminant A', 0.4476, 0.4074, '2854.9', '−0.0000'],
    ['D50', 0.3457, 0.3585, '5000.7', '+0.0032'],
    ['D55', 0.3324, 0.3474, '5502.3', '+0.0032'],
  ])('%s', (_name, x, y, kelvin, duv) => {
    const measurement = measureXY({ x, y });
    expect(measurement.kelvin.toFixed(1)).toBe(kelvin);
    expect(formatDuv(measurement.duv)).toBe(duv);
  });
});
