import { describe, expect, it } from 'vitest';
import { temperatureTintToXY, xyToTemperatureTint } from './adobeTint.ts';
import { planckianXY } from './planck.ts';
import { measureXY } from './duv.ts';
import { xyToCCT } from './robertson.ts';

describe('Adobe temperature/tint', () => {
  it('round-trips xy -> (temp, tint) -> xy', () => {
    for (const kelvin of [2000, 2700, 3200, 4000, 5000, 6500, 9000, 15000]) {
      for (const tint of [-40, -10, 0, 10, 40]) {
        const xy = temperatureTintToXY(kelvin, tint);
        const back = xyToTemperatureTint(xy);
        expect(back.kelvin, `${kelvin} K tint ${tint}`).toBeCloseTo(kelvin, 0);
        expect(back.tint, `${kelvin} K tint ${tint}`).toBeCloseTo(tint, 2);
      }
    }
  });

  it('reports zero tint on the Planckian locus', () => {
    for (const kelvin of [2000, 2856, 3200, 4000, 5000, 6500, 10000]) {
      const { tint } = xyToTemperatureTint(planckianXY(kelvin));
      expect(Math.abs(tint), `${kelvin} K`).toBeLessThan(1.5);
    }
  });

  it('agrees with Robertson CCT to within 1% across the working range', () => {
    // Adobe interpolates the same table slightly differently, so the two
    // temperatures are close but not identical. Anything worse than 1% would
    // mean one of them is wrong.
    for (const kelvin of [2000, 2700, 3200, 4000, 5000, 6500, 10000]) {
      const xy = planckianXY(kelvin);
      const adobe = xyToTemperatureTint(xy).kelvin;
      const robertson = xyToCCT(xy).kelvin;
      expect(Math.abs(adobe - robertson) / robertson, `${kelvin} K`).toBeLessThan(0.01);
    }
  });

  it('reads greenish light as positive (magenta-correcting) tint', () => {
    // Positive Duv is green; the slider value that cancels green is magenta,
    // which is the positive end of the Adobe tint scale.
    const greenish = temperatureTintToXY(4000, 30);
    expect(measureXY(greenish).duv).toBeGreaterThan(0);

    const magentaish = temperatureTintToXY(4000, -30);
    expect(measureXY(magentaish).duv).toBeLessThan(0);
  });

  it('reads daylight as slightly positive tint, matching its green Duv', () => {
    const d65 = { x: 0.3127, y: 0.329 };
    const { tint } = xyToTemperatureTint(d65);
    expect(tint).toBeGreaterThan(0);
    expect(tint).toBeLessThan(20);
    expect(measureXY(d65).duv).toBeGreaterThan(0);
  });

  it('reports D65 near 6500 K on the Adobe scale', () => {
    const { kelvin } = xyToTemperatureTint({ x: 0.3127, y: 0.329 });
    expect(Math.abs(kelvin - 6504)).toBeLessThan(60);
  });

  it('clamps and flags tint beyond the slider range', () => {
    // A chromaticity 200 tint units green of the locus is still inside the
    // spectral horseshoe, but it is off the end of the slider.
    const result = xyToTemperatureTint(temperatureTintToXY(5000, 200));
    expect(result.tintClipped).toBe(true);
    expect(result.tint).toBe(150);
  });

  it('does not flag clipping for tints inside the slider range', () => {
    const result = xyToTemperatureTint(temperatureTintToXY(5000, 120));
    expect(result.tintClipped).toBe(false);
  });
});
