import { describe, expect, it } from 'vitest';
import { StabilityTracker, computeFeatures, type PatchReading } from './features.ts';
import {
  CLIPPING_CODE,
  LOW_SIGNAL_CODE,
  assessPatch,
  defaultGuideRects,
  samplePatch,
} from './sampling.ts';
import { REFERENCE_CARDS, findCard, patchForRole } from './cards.ts';
import { linearToSrgb, srgbToLinear } from '../color/index.ts';

/** Build an RGBA buffer of a single flat colour. */
function flatBuffer(width: number, height: number, rgb: [number, number, number]) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = rgb[0];
    data[i * 4 + 1] = rgb[1];
    data[i * 4 + 2] = rgb[2];
    data[i * 4 + 3] = 255;
  }
  return data;
}

function sampleOf(rgb: [number, number, number]) {
  const data = flatBuffer(20, 20, rgb);
  return samplePatch(data, 20, 20, { x: 0, y: 0, width: 1, height: 1 });
}

describe('patch sampling', () => {
  it('linearises before averaging', () => {
    const sample = sampleOf([128, 128, 128]);
    expect(sample.encoded[0]).toBeCloseTo(128, 6);
    expect(sample.linear[0]).toBeCloseTo(srgbToLinear(128 / 255), 6);
    // The linear mean is far below the encoded mean, which is the whole point.
    expect(sample.linear[0]).toBeLessThan(0.25);
  });

  it('averages in linear light, not in code values', () => {
    // Half the region at 20% code, half at 80% code.
    const width = 20;
    const height = 20;
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const code = y < height / 2 ? 51 : 204;
        const index = (y * width + x) * 4;
        data[index] = code;
        data[index + 1] = code;
        data[index + 2] = code;
        data[index + 3] = 255;
      }
    }
    const sample = samplePatch(data, width, height, { x: 0, y: 0, width: 1, height: 1 });
    const trueLinearMean = (srgbToLinear(51 / 255) + srgbToLinear(204 / 255)) / 2;
    expect(sample.linear[0]).toBeCloseTo(trueLinearMean, 6);
    // Encoding the linear mean back gives ~0.6, not the 0.5 a naive average
    // of code values would suggest.
    expect(linearToSrgb(sample.linear[0]!)).toBeGreaterThan(0.55);
  });

  it('trims outliers so a glint does not drag the sample', () => {
    const width = 20;
    const height = 20;
    const data = flatBuffer(width, height, [100, 100, 100]);
    // 5% of pixels blown out by a specular highlight.
    for (let i = 0; i < 20; i++) {
      data[i * 4] = 255;
      data[i * 4 + 1] = 255;
      data[i * 4 + 2] = 255;
    }
    const sample = samplePatch(data, width, height, { x: 0, y: 0, width: 1, height: 1 });
    expect(sample.encoded[0]).toBeCloseTo(100, 6);
  });

  it('reports the clipped fraction even when the trimmed mean survives', () => {
    const width = 20;
    const height = 20;
    const data = flatBuffer(width, height, [100, 100, 100]);
    for (let i = 0; i < 40; i++) {
      data[i * 4] = 255;
      data[i * 4 + 1] = 255;
      data[i * 4 + 2] = 255;
    }
    const sample = samplePatch(data, width, height, { x: 0, y: 0, width: 1, height: 1 });
    expect(sample.clippedFraction).toBeCloseTo(40 / 400, 6);
    expect(assessPatch(sample).problem).toBe('clipping');
  });

  it('handles a zero-area rectangle without dividing by zero', () => {
    const data = flatBuffer(10, 10, [128, 128, 128]);
    const sample = samplePatch(data, 10, 10, { x: 0.5, y: 0.5, width: 0, height: 0 });
    expect(sample.pixelCount).toBe(0);
    expect(assessPatch(sample).problem).toBe('no-pixels');
  });

  it('clamps rectangles that run off the frame', () => {
    const data = flatBuffer(10, 10, [128, 128, 128]);
    const sample = samplePatch(data, 10, 10, { x: 0.8, y: 0.8, width: 0.5, height: 0.5 });
    expect(sample.pixelCount).toBeGreaterThan(0);
    expect(sample.encoded[0]).toBeCloseTo(128, 6);
  });
});

describe('patch quality gates', () => {
  it('rejects a clipped patch', () => {
    expect(assessPatch(sampleOf([CLIPPING_CODE, 100, 100])).ok).toBe(false);
    expect(assessPatch(sampleOf([CLIPPING_CODE, 100, 100])).problem).toBe('clipping');
  });

  it('rejects a patch below 10% of range', () => {
    const dark = LOW_SIGNAL_CODE - 1;
    expect(assessPatch(sampleOf([dark, dark, dark])).problem).toBe('too-dark');
  });

  it('accepts a patch that is dark in one channel but not overall', () => {
    // A saturated blue patch has a near-black red channel and is still usable.
    expect(assessPatch(sampleOf([8, 40, 180])).ok).toBe(true);
  });

  it('accepts a well-exposed mid patch', () => {
    expect(assessPatch(sampleOf([120, 130, 110])).ok).toBe(true);
  });
});

/**
 * A simulated camera: true sensor responses for four patches, then a global
 * per-channel auto white balance gain applied on top, then sRGB encoding.
 * This is the model the whole method rests on, so it is worth testing
 * directly.
 */
function simulateFrame(
  sensorResponses: Record<string, [number, number, number]>,
  awbGains: [number, number, number],
): PatchReading[] {
  return (['warm', 'cool', 'green', 'neutral'] as const).map((role) => {
    const response = sensorResponses[role]!;
    const gained = response.map((value, i) => value * awbGains[i]!) as [number, number, number];
    const encoded = gained.map((value) => Math.round(linearToSrgb(value) * 255)) as [
      number,
      number,
      number,
    ];
    return { role, sample: sampleOf(encoded) };
  });
}

// Plausible linear sensor responses under a mid-temperature illuminant.
const NEUTRAL_SCENE: Record<string, [number, number, number]> = {
  warm: [0.42, 0.18, 0.06],
  cool: [0.06, 0.22, 0.36],
  green: [0.12, 0.32, 0.10],
  neutral: [0.24, 0.24, 0.24],
};

// The same patches under warmer light: more long-wavelength energy, so the
// warm patch gains in red and everything loses in blue.
const WARM_SCENE: Record<string, [number, number, number]> = {
  warm: [0.52, 0.18, 0.035],
  cool: [0.075, 0.22, 0.22],
  green: [0.15, 0.32, 0.06],
  neutral: [0.30, 0.24, 0.15],
};

describe('AWB-invariant feature extraction', () => {
  it('is unchanged by the auto white balance gains, which is the entire premise', () => {
    // The same scene, three very different sets of AWB gains. If the feature
    // moved with the gains the method would be measuring the camera's
    // guess rather than the light.
    const baseline = computeFeatures(simulateFrame(NEUTRAL_SCENE, [1, 1, 1]));
    const aggressive = computeFeatures(simulateFrame(NEUTRAL_SCENE, [1.9, 1.0, 0.55]));
    const opposite = computeFeatures(simulateFrame(NEUTRAL_SCENE, [0.6, 1.0, 1.7]));

    expect(baseline.ok).toBe(true);
    expect(aggressive.ok).toBe(true);
    expect(opposite.ok).toBe(true);

    // Tolerance is set by 8-bit quantisation of the simulated frame, not by
    // the maths, which cancels exactly.
    expect(aggressive.warmth).toBeCloseTo(baseline.warmth, 1);
    expect(opposite.warmth).toBeCloseTo(baseline.warmth, 1);
    expect(aggressive.greenness).toBeCloseTo(baseline.greenness, 1);
  });

  it('cancels the gains exactly when quantisation is taken out of the picture', () => {
    // Same check without the 8-bit round trip: the cancellation is algebraic.
    const build = (gains: [number, number, number]): PatchReading[] =>
      (['warm', 'cool', 'green', 'neutral'] as const).map((role) => {
        const response = NEUTRAL_SCENE[role]!;
        return {
          role,
          sample: {
            linear: response.map((v, i) => v * gains[i]!) as [number, number, number],
            encoded: [128, 128, 128],
            clippedFraction: 0,
            pixelCount: 100,
          },
        };
      });

    const a = computeFeatures(build([1, 1, 1]));
    const b = computeFeatures(build([2.3, 0.8, 0.45]));
    expect(b.warmth).toBeCloseTo(a.warmth, 12);
    expect(b.greenness).toBeCloseTo(a.greenness, 12);
  });

  it('rises with colour temperature of the source', () => {
    const neutral = computeFeatures(simulateFrame(NEUTRAL_SCENE, [1.3, 1, 0.9]));
    const warm = computeFeatures(simulateFrame(WARM_SCENE, [1.6, 1, 0.7]));
    // Warmer light separates the warm and cool patches further in red and
    // pushes them together in blue, so the feature increases.
    expect(warm.warmth).toBeGreaterThan(neutral.warmth);
  });

  it('reports which patch is at fault rather than a bare failure', () => {
    const readings = simulateFrame(NEUTRAL_SCENE, [1, 1, 1]);
    readings[1] = { role: 'cool', sample: sampleOf([2, 2, 3]) };
    const result = computeFeatures(readings);
    expect(result.ok).toBe(false);
    expect(result.problems).toContainEqual({ role: 'cool', problem: 'too-dark' });
  });

  it('cannot produce a warmth value without both the warm and cool patches', () => {
    const readings = simulateFrame(NEUTRAL_SCENE, [1, 1, 1]).filter(
      (reading) => reading.role !== 'cool',
    );
    const result = computeFeatures(readings);
    expect(result.ok).toBe(false);
    expect(Number.isNaN(result.warmth)).toBe(true);
    expect(result.problems.some((p) => p.role === 'cool')).toBe(true);
  });

  it('still gives a warmth reading when only the tint patches are missing', () => {
    const readings = simulateFrame(NEUTRAL_SCENE, [1, 1, 1]).filter(
      (reading) => reading.role === 'warm' || reading.role === 'cool',
    );
    const result = computeFeatures(readings);
    expect(Number.isFinite(result.warmth)).toBe(true);
    expect(Number.isNaN(result.greenness)).toBe(true);
    expect(result.ok).toBe(false); // still flagged, because the card is incomplete
  });

  it('does not divide by zero on a black patch', () => {
    const readings: PatchReading[] = (['warm', 'cool', 'green', 'neutral'] as const).map(
      (role) => ({
        role,
        sample: {
          linear: [0, 0, 0],
          encoded: [200, 200, 200],
          clippedFraction: 0,
          pixelCount: 100,
        },
      }),
    );
    const result = computeFeatures(readings);
    expect(Number.isFinite(result.warmth)).toBe(true);
    expect(result.warmth).toBeCloseTo(0, 9);
  });
});

describe('stability tracking', () => {
  it('reports a small spread for a steady reading', () => {
    const tracker = new StabilityTracker();
    for (let i = 0; i < 10; i++) tracker.push(0.5 + (i % 2) * 0.001);
    expect(tracker.ready).toBe(true);
    expect(tracker.standardDeviation).toBeLessThan(0.01);
  });

  it('reports a large spread for a swinging reading', () => {
    const tracker = new StabilityTracker();
    for (let i = 0; i < 10; i++) tracker.push(0.5 + (i % 2) * 0.4);
    expect(tracker.standardDeviation).toBeGreaterThan(0.1);
  });

  it('is not ready until it has enough history to judge', () => {
    const tracker = new StabilityTracker();
    expect(tracker.ready).toBe(false);
    tracker.push(1);
    expect(tracker.ready).toBe(false);
    expect(Number.isNaN(tracker.standardDeviation)).toBe(true);
  });

  it('keeps only the most recent window', () => {
    const tracker = new StabilityTracker(4);
    for (const value of [1, 1, 1, 1, 9, 9, 9, 9]) tracker.push(value);
    expect(tracker.count).toBe(4);
    expect(tracker.mean).toBeCloseTo(9, 9);
  });

  it('ignores non-finite pushes', () => {
    const tracker = new StabilityTracker();
    tracker.push(Number.NaN);
    tracker.push(Infinity);
    expect(tracker.count).toBe(0);
  });
});

describe('reference cards', () => {
  it('defines all four roles for every card', () => {
    for (const card of REFERENCE_CARDS) {
      for (const role of ['warm', 'cool', 'green', 'neutral'] as const) {
        expect(patchForRole(card, role), `${card.id} ${role}`).not.toBeNull();
      }
    }
  });

  it('gives every patch a short label that will not collide with its neighbour', () => {
    // The guide boxes sit close together on purpose, so these are rendered
    // side by side under adjacent boxes about 45px wide.
    for (const card of REFERENCE_CARDS) {
      for (const patch of card.patches) {
        expect(patch.shortName.length, `${card.id} ${patch.role}`).toBeLessThanOrEqual(6);
        expect(patch.shortName).not.toMatch(/\s/);
      }
    }
  });

  it('has unique ids and valid swatch colours', () => {
    const ids = REFERENCE_CARDS.map((card) => card.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const card of REFERENCE_CARDS) {
      for (const patch of card.patches) {
        expect(patch.swatch, `${card.id} ${patch.role}`).toMatch(/^#[0-9a-f]{6}$/);
      }
    }
  });

  it('looks a card up by id', () => {
    expect(findCard('cc-passport')?.name).toContain('Passport');
    expect(findCard('nope')).toBeNull();
    expect(findCard(null)).toBeNull();
  });
});

describe('guide box layout', () => {
  it('lays four non-overlapping boxes across the middle of the frame', () => {
    const rects = defaultGuideRects(4);
    expect(rects).toHaveLength(4);
    for (const rect of rects) {
      expect(rect.x).toBeGreaterThanOrEqual(0);
      expect(rect.x + rect.width).toBeLessThanOrEqual(1);
      expect(rect.y).toBeGreaterThanOrEqual(0);
      expect(rect.y + rect.height).toBeLessThanOrEqual(1);
    }
    for (let i = 1; i < rects.length; i++) {
      expect(rects[i]!.x).toBeGreaterThan(rects[i - 1]!.x + rects[i - 1]!.width);
    }
  });

  it('keeps the boxes adjacent, since iOS tone mapping varies across the frame', () => {
    const rects = defaultGuideRects(4);
    const span = rects[3]!.x + rects[3]!.width - rects[0]!.x;
    expect(span).toBeLessThan(0.7);
  });
});
