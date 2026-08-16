import { describe, expect, it } from 'vitest';
import { ROBERTSON_TABLE } from './robertson.ts';
import { PLANCK_C2_1931, daylightXY, planckianUV, planckianXY } from './planck.ts';
import { xyToUV } from './chromaticity.ts';
import { CMF_END_NM, CMF_SAMPLE_COUNT, CMF_START_NM } from './cmf.ts';

describe('CIE 1931 2-degree colour matching functions', () => {
  it('spans 360-830 nm at 5 nm with a complete table', () => {
    expect(CMF_SAMPLE_COUNT).toBe(95);
    expect(CMF_START_NM).toBe(360);
    expect(CMF_END_NM).toBe(830);
  });
});

describe('Planckian locus vs the Robertson isotemperature table', () => {
  // The two data sources are completely independent: one is a transcribed
  // table of isotemperature lines, the other is Planck's law integrated
  // against a transcribed observer. If both agree everywhere, neither
  // transcription is meaningfully wrong.
  //
  // Compared using the 1931-era c2 the Robertson table was computed with,
  // so the only residual is quadrature error and the table's own rounding.
  it('agrees to better than 1.5e-4 in u and v at every tabulated temperature', () => {
    for (const line of ROBERTSON_TABLE) {
      if (line.r === 0) continue; // infinite temperature has no finite integral
      const kelvin = 1e6 / line.r;
      const uv = planckianUV(kelvin, PLANCK_C2_1931);
      expect(Math.abs(uv.u - line.u), `u at ${Math.round(kelvin)} K`).toBeLessThan(1.5e-4);
      expect(Math.abs(uv.v - line.v), `v at ${Math.round(kelvin)} K`).toBeLessThan(1.5e-4);
    }
  });

  it('still agrees within 2e-4 using the modern value of c2', () => {
    for (const line of ROBERTSON_TABLE) {
      if (line.r === 0) continue;
      const kelvin = 1e6 / line.r;
      const uv = planckianUV(kelvin);
      expect(Math.abs(uv.u - line.u)).toBeLessThan(2e-4);
      expect(Math.abs(uv.v - line.v)).toBeLessThan(2e-4);
    }
  });

  it('is monotonic in u as temperature falls', () => {
    let previous = -Infinity;
    for (let mired = 25; mired <= 600; mired += 25) {
      const { u } = planckianUV(1e6 / mired);
      expect(u).toBeGreaterThan(previous);
      previous = u;
    }
  });
});

describe('Planckian locus landmarks', () => {
  it('places CIE Illuminant A at its defined chromaticity', () => {
    // Illuminant A is a Planckian radiator at 2856 K (2848 K on the 1931
    // scale) with defined chromaticity x = 0.44757, y = 0.40745.
    const xy = planckianXY(2856);
    expect(xy.x).toBeCloseTo(0.44757, 3);
    expect(xy.y).toBeCloseTo(0.40745, 3);
  });

  it('converges towards the blue end at very high temperatures', () => {
    const hot = planckianXY(100000);
    expect(hot.x).toBeLessThan(0.25);
    expect(hot.y).toBeLessThan(0.26);
  });
});

describe('CIE daylight locus', () => {
  // The D-series names encode temperatures on the 1931 scale. The 1968
  // revision of c2 scaled them by 1.4388 / 1.4380, so "D65" is a daylight
  // illuminant at 6504 K, not 6500 K. Feeding the nominal figure into the
  // locus formula misses the defined chromaticity by ~6e-5 in x.
  const D_SERIES_SCALE = 1.4388 / 1.438;

  // x comes from the cubic and lands within 5e-5 of the published values.
  // y comes from the quadratic y(x) relation, which is itself a fit to the
  // S0/S1/S2 daylight basis and carries about 1e-4 of residual. That residual
  // is a property of the CIE formula, not of this implementation, so the
  // tolerances differ by axis on purpose.
  const X_TOLERANCE = 5e-5;
  const Y_TOLERANCE = 1.5e-4;

  it.each([
    ['D50', 5000, 0.34567, 0.3585],
    ['D55', 5500, 0.33243, 0.34744],
    ['D65', 6500, 0.31272, 0.32903],
    ['D75', 7500, 0.29902, 0.31485],
  ])('reproduces %s at its corrected temperature', (_name, nominal, x, y) => {
    const xy = daylightXY(nominal * D_SERIES_SCALE);
    expect(Math.abs(xy.x - x)).toBeLessThan(X_TOLERANCE);
    expect(Math.abs(xy.y - y)).toBeLessThan(Y_TOLERANCE);
  });

  it('sits above the Planckian locus in v for daylight temperatures', () => {
    // Daylight is famously slightly green of the blackbody locus.
    const day = xyToUV(daylightXY(6500));
    const black = planckianUV(6504);
    expect(day.v).toBeGreaterThan(black.v);
  });

  it('refuses to extrapolate outside 4000-25000 K', () => {
    expect(() => daylightXY(3000)).toThrow();
    expect(() => daylightXY(30000)).toThrow();
  });
});
