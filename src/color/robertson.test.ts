import { describe, expect, it } from 'vitest';
import { xyToCCT, uvToCCT, ROBERTSON_TABLE } from './robertson.ts';
import { measureXY } from './duv.ts';
import { planckianUV, planckianXY } from './planck.ts';
import { xyToUV } from './chromaticity.ts';

describe('Robertson CCT against standard illuminants', () => {
  // These are the acceptance cases from the build spec. Tolerances are tight
  // (a few K) because the inputs are rounded to 4 decimal places, and a 1e-5
  // wobble in xy is worth a couple of Kelvin near daylight.
  it.each([
    ['D65', 0.3127, 0.329, 6504],
    ['CIE Illuminant A', 0.4476, 0.4074, 2856],
    ['D50', 0.3457, 0.3585, 5003],
    ['D55', 0.3324, 0.3474, 5503],
  ])('%s -> %s K', (_name, x, y, expected) => {
    const { kelvin, outOfRange } = xyToCCT({ x, y });
    expect(outOfRange).toBe(false);
    expect(Math.abs(kelvin - expected)).toBeLessThan(6);
  });

  it('reports D65 as essentially on the locus', () => {
    const { duv } = measureXY({ x: 0.3127, y: 0.329 });
    // D65 is daylight, which sits very slightly green of the blackbody locus.
    expect(Math.abs(duv)).toBeLessThan(0.004);
  });

  it('reports CIE Illuminant A as on the locus, because it is a blackbody', () => {
    const { duv, kelvin } = measureXY({ x: 0.44757, y: 0.40745 });
    expect(Math.abs(duv)).toBeLessThan(0.0005);
    expect(Math.abs(kelvin - 2856)).toBeLessThan(6);
  });
});

describe('Robertson CCT round-trips the Planckian locus', () => {
  it('recovers the source temperature to within 0.5% from 1700 K to 20000 K', () => {
    for (const kelvin of [1700, 2000, 2400, 2700, 3000, 3200, 4000, 5000, 5600, 6500, 7500, 10000, 20000]) {
      const uv = planckianUV(kelvin);
      const result = uvToCCT(uv);
      expect(result.outOfRange).toBe(false);
      const relativeError = Math.abs(result.kelvin - kelvin) / kelvin;
      expect(relativeError, `${kelvin} K -> ${result.kelvin.toFixed(1)} K`).toBeLessThan(0.005);
    }
  });

  it('reports Duv near zero everywhere on the locus', () => {
    for (let mired = 50; mired <= 580; mired += 10) {
      const kelvin = 1e6 / mired;
      const { duv } = measureXY(planckianXY(kelvin));
      expect(Math.abs(duv), `${Math.round(kelvin)} K`).toBeLessThan(0.0004);
    }
  });
});

/**
 * Unit normal to the Planckian locus at `kelvin`, pointing towards +v (green).
 * Duv is measured along this direction, and Robertson's isotemperature lines
 * are by construction parallel to it — which the tests below rely on.
 */
function locusNormal(kelvin: number): { u: number; v: number } {
  const ahead = planckianUV(kelvin + 1);
  const behind = planckianUV(kelvin - 1);
  const tu = ahead.u - behind.u;
  const tv = ahead.v - behind.v;
  const length = Math.hypot(tu, tv);
  // Rotate the tangent by 90 degrees, then orient it green-side up.
  const nu = -tv / length;
  const nv = tu / length;
  return nv >= 0 ? { u: nu, v: nv } : { u: -nu, v: -nv };
}

function offsetFromLocus(kelvin: number, distance: number) {
  const base = planckianUV(kelvin);
  const normal = locusNormal(kelvin);
  return uvToXY({ u: base.u + normal.u * distance, v: base.v + normal.v * distance });
}

describe('Duv sign convention', () => {
  it.each([2700, 4000, 6500])(
    'is positive above the locus and negative below it at %i K',
    (kelvin) => {
      const green = measureXY(offsetFromLocus(kelvin, 0.01));
      const magenta = measureXY(offsetFromLocus(kelvin, -0.01));
      expect(green.duv).toBeGreaterThan(0);
      expect(magenta.duv).toBeLessThan(0);
      expect(Math.abs(green.duv)).toBeCloseTo(0.01, 3);
      expect(Math.abs(magenta.duv)).toBeCloseTo(0.01, 3);
    },
  );

  it("recovers the source temperature for points off the locus, because Robertson's isotherms are normal to it", () => {
    for (const kelvin of [2700, 4000, 6500]) {
      for (const offset of [-0.02, -0.01, 0.01, 0.02]) {
        const result = measureXY(offsetFromLocus(kelvin, offset));
        const relativeError = Math.abs(result.kelvin - kelvin) / kelvin;
        expect(relativeError, `${kelvin} K at Duv ${offset}`).toBeLessThan(0.01);
      }
    }
  });

  it('flags chromaticities too far from the locus to have a meaningful CCT', () => {
    const wayOff = measureXY(offsetFromLocus(4000, 0.08));
    expect(wayOff.farFromLocus).toBe(true);
  });
});

describe('Robertson range handling', () => {
  it('flags chromaticities hotter than the table resolves', () => {
    // Well past the r = 0 end of the table.
    const result = uvToCCT({ u: 0.16, v: 0.24 });
    expect(result.outOfRange).toBe(true);
  });

  it('flags chromaticities cooler than 1667 K', () => {
    const result = uvToCCT({ u: 0.45, v: 0.35 });
    expect(result.outOfRange).toBe(true);
  });

  it('has a strictly increasing reciprocal-temperature table', () => {
    for (let i = 1; i < ROBERTSON_TABLE.length; i++) {
      expect(ROBERTSON_TABLE[i]!.r).toBeGreaterThan(ROBERTSON_TABLE[i - 1]!.r);
    }
  });
});

function uvToXY(uv: { u: number; v: number }) {
  const denom = 2 * uv.u - 8 * uv.v + 4;
  return { x: (3 * uv.u) / denom, y: (2 * uv.v) / denom };
}

describe('uv <-> xy conversions', () => {
  it('round-trips', () => {
    const xy = { x: 0.3457, y: 0.3585 };
    const back = uvToXY(xyToUV(xy));
    expect(back.x).toBeCloseTo(xy.x, 10);
    expect(back.y).toBeCloseTo(xy.y, 10);
  });
});
