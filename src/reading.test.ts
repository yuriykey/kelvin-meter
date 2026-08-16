import { describe, expect, it } from 'vitest';
import { blockingWarning, readingFromDng, readingFromLive } from './reading.ts';
import { createProfile, addPoint } from './calibration/index.ts';
import {
  kelvinToMired,
  measureXY,
  temperatureTintToXY,
  xyToTemperatureTint,
} from './color/index.ts';
import type { SolveResult } from './dng/index.ts';
import type { FeatureResult } from './live/index.ts';
import type { PatchRole } from './live/index.ts';

function solveResult(x: number, y: number, overrides: Partial<SolveResult> = {}): SolveResult {
  const xy = { x, y };
  return {
    xy,
    measurement: measureXY(xy),
    adobe: xyToTemperatureTint(xy),
    source: 'AsShotNeutral + ColorMatrix interpolation',
    iterations: 3,
    converged: true,
    interpolation: {
      warmWeight: 0.7,
      warmKelvin: 2850,
      coolKelvin: 6500,
      warmName: 'Standard light A',
      coolName: 'D65',
    },
    ...overrides,
  };
}

function features(overrides: Partial<FeatureResult> = {}): FeatureResult {
  return { warmth: 0.5, greenness: 0.01, ok: true, problems: [], ...overrides };
}

function problem(role: PatchRole, kind: 'clipping' | 'too-dark' | 'missing-patch') {
  return { role, problem: kind } as const;
}

describe('readings from a DNG', () => {
  it('passes an uncalibrated reading straight through', () => {
    const reading = readingFromDng(solveResult(0.4091, 0.3906), null, 'a.dng');
    expect(reading.calibrated).toBe(false);
    expect(reading.mode).toBe('raw');
    expect(reading.kelvin).toBeCloseTo(reading.rawKelvin, 9);
    expect(blockingWarning(reading)).toBeNull();
  });

  it('applies a calibration profile and says which one', () => {
    let profile = createProfile({ name: 'ProRAW', mode: 'raw' });
    profile = addPoint(profile, {
      measured: kelvinToMired(3400),
      referenceKelvin: 3200,
      measuredTint: 0,
      referenceTint: 0,
      label: 'a',
    });
    const reading = readingFromDng(solveResult(0.4091, 0.3906), profile, 'a.dng');
    expect(reading.calibrated).toBe(true);
    expect(reading.profileName).toBe('ProRAW');
    expect(reading.kelvin).toBeLessThan(reading.rawKelvin);
  });

  it('names both calibration illuminants in the audit rows', () => {
    const reading = readingFromDng(solveResult(0.4091, 0.3906), null, 'a.dng');
    const blend = reading.details.find((row) => row.label === 'Matrix blend');
    expect(blend?.value).toBe('70% Standard light A (2850 K) · 30% D65 (6500 K)');
  });

  it('blocks the reading when the light is too far off the Planckian locus', () => {
    // 200 Adobe tint units is a uv offset of 0.067, past the ±0.05 limit
    // where a correlated colour temperature stops describing the light.
    const farOff = temperatureTintToXY(4000, 200);
    const reading = readingFromDng(solveResult(farOff.x, farOff.y), null, 'a.dng');
    const warning = blockingWarning(reading);
    expect(warning?.kind).toBe('OFF LOCUS');
    expect(warning?.detail).toMatch(/duv/i);
  });

  it('does not block a merely greenish light that CCT still describes', () => {
    // 60 tint units is 0.02 in uv: visibly green, well inside the limit.
    const greenish = temperatureTintToXY(4000, 60);
    const reading = readingFromDng(solveResult(greenish.x, greenish.y), null, 'a.dng');
    expect(blockingWarning(reading)).toBeNull();
    expect(reading.duv).toBeGreaterThan(0.01);
  });

  it('blocks the reading when the solve did not converge', () => {
    const reading = readingFromDng(
      solveResult(0.4091, 0.3906, { converged: false }),
      null,
      'a.dng',
    );
    expect(blockingWarning(reading)?.kind).toBe('OUT OF RANGE');
  });

  it('warns without blocking when a reading sits outside the calibrated span', () => {
    let profile = createProfile({ name: 'ProRAW', mode: 'raw' });
    for (const [measured, reference] of [
      [2800, 2700],
      [3000, 2900],
    ] as const) {
      profile = addPoint(profile, {
        measured: kelvinToMired(measured),
        referenceKelvin: reference,
        measuredTint: 0,
        referenceTint: 0,
        label: `${reference}`,
      });
    }
    // A daylight reading is far outside a 2700-2900 K calibration.
    const reading = readingFromDng(solveResult(0.3127, 0.329), profile, 'a.dng');
    expect(reading.extrapolated).toBe(true);
    expect(blockingWarning(reading)).toBeNull();
    expect(reading.warnings.some((w) => !w.blocking)).toBe(true);
  });
});

describe('readings from live mode', () => {
  const calibrated = (() => {
    let profile = createProfile({ name: 'Passport', mode: 'live', cardId: 'cc-passport' });
    profile = addPoint(profile, {
      measured: 0.2,
      referenceKelvin: 5600,
      measuredTint: 0,
      referenceTint: 0,
      label: 'a',
    });
    profile = addPoint(profile, {
      measured: 0.9,
      referenceKelvin: 3200,
      measuredTint: 0,
      referenceTint: 0,
      label: 'b',
    });
    return profile;
  })();

  it('blocks with NO CALIBRATION when there is no profile', () => {
    const reading = readingFromLive(
      { features: features(), featureSpread: 0, stabilityReady: false },
      null,
    );
    expect(blockingWarning(reading)?.kind).toBe('NO CALIBRATION');
  });

  it('blocks with NO CALIBRATION when a profile has fewer than two points', () => {
    let profile = createProfile({ name: 'Passport', mode: 'live', cardId: 'cc-passport' });
    profile = addPoint(profile, {
      measured: 0.2,
      referenceKelvin: 5600,
      measuredTint: 0,
      referenceTint: 0,
      label: 'a',
    });
    const reading = readingFromLive(
      { features: features(), featureSpread: 0, stabilityReady: false },
      profile,
    );
    expect(blockingWarning(reading)?.kind).toBe('NO CALIBRATION');
  });

  it('reports a temperature once calibrated, and labels the mode', () => {
    const reading = readingFromLive(
      { features: features({ warmth: 0.55 }), featureSpread: 0.001, stabilityReady: true },
      calibrated,
    );
    expect(blockingWarning(reading)).toBeNull();
    expect(reading.mode).toBe('live');
    expect(reading.kelvin).toBeGreaterThan(3200);
    expect(reading.kelvin).toBeLessThan(5600);
    expect(reading.calibrated).toBe(true);
  });

  it('blocks on clipping before anything else', () => {
    const reading = readingFromLive(
      {
        features: features({ ok: false, problems: [problem('green', 'clipping')] }),
        featureSpread: 0,
        stabilityReady: false,
      },
      calibrated,
    );
    expect(blockingWarning(reading)?.kind).toBe('CLIPPING');
  });

  describe('warning wording', () => {
    it('agrees in number for a single patch', () => {
      const reading = readingFromLive(
        {
          features: features({ ok: false, problems: [problem('green', 'clipping')] }),
          featureSpread: 0,
          stabilityReady: false,
        },
        calibrated,
      );
      expect(blockingWarning(reading)!.detail).toContain('The green patch is blown out');
    });

    it('agrees in number for two patches', () => {
      const reading = readingFromLive(
        {
          features: features({
            ok: false,
            problems: [problem('green', 'clipping'), problem('warm', 'clipping')],
          }),
          featureSpread: 0,
          stabilityReady: false,
        },
        calibrated,
      );
      expect(blockingWarning(reading)!.detail).toContain('The green and warm patches are blown out');
    });

    it('agrees in number for three or more patches', () => {
      const reading = readingFromLive(
        {
          features: features({
            ok: false,
            problems: [
              problem('green', 'too-dark'),
              problem('warm', 'too-dark'),
              problem('cool', 'too-dark'),
            ],
          }),
          featureSpread: 0,
          stabilityReady: false,
        },
        calibrated,
      );
      expect(blockingWarning(reading)!.detail).toContain(
        'The green, warm and cool patches are below 10% of range',
      );
    });

    it('never leaves a warning that reads as a sentence fragment', () => {
      for (const kind of ['clipping', 'too-dark', 'missing-patch'] as const) {
        for (const roles of [['green'], ['green', 'warm'], ['green', 'warm', 'cool']] as const) {
          const reading = readingFromLive(
            {
              features: features({
                ok: false,
                problems: roles.map((role) => problem(role as PatchRole, kind)),
              }),
              featureSpread: 0,
              stabilityReady: false,
            },
            calibrated,
          );
          const detail = blockingWarning(reading)!.detail;
          expect(detail, detail).toMatch(/ (is|are) /);
          expect(detail, detail).toMatch(/\.$/);
        }
      }
    });
  });

  it('flags an unstable reading without blocking it', () => {
    const reading = readingFromLive(
      { features: features({ warmth: 0.55 }), featureSpread: 0.25, stabilityReady: true },
      calibrated,
    );
    expect(blockingWarning(reading)).toBeNull();
    expect(reading.warnings.some((w) => w.kind === 'UNSTABLE')).toBe(true);
  });

  it('stores the feature so the reading can be calibrated against later', () => {
    const reading = readingFromLive(
      { features: features({ warmth: 0.42 }), featureSpread: 0, stabilityReady: false },
      calibrated,
    );
    expect(reading.feature).toBeCloseTo(0.42, 9);
  });
});
