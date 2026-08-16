import { describe, expect, it } from 'vitest';
import {
  curveResiduals,
  curveRmsResidual,
  evaluateCurve,
  prepareKnots,
  type CurvePoint,
} from './curve.ts';
import {
  addPoint,
  applyCalibration,
  createProfile,
  profileResiduals,
  removePoint,
  withFieldTrim,
  withTintOffset,
  fitTintOffset,
} from './profile.ts';
import { kelvinToMired, miredToKelvin } from '../color/index.ts';

describe('piecewise-linear curve fitting', () => {
  it('reproduces both points of a two-point fit exactly', () => {
    const points: CurvePoint[] = [
      { x: 100, y: 110 },
      { x: 400, y: 380 },
    ];
    const knots = prepareKnots(points);
    expect(evaluateCurve(knots, 100).value).toBeCloseTo(110, 12);
    expect(evaluateCurve(knots, 400).value).toBeCloseTo(380, 12);
    expect(evaluateCurve(knots, 100).extrapolated).toBe(false);
    expect(evaluateCurve(knots, 400).extrapolated).toBe(false);
  });

  it('interpolates linearly and monotonically between two points', () => {
    const knots = prepareKnots([
      { x: 100, y: 110 },
      { x: 400, y: 380 },
    ]);
    expect(evaluateCurve(knots, 250).value).toBeCloseTo(245, 12);

    let previous = -Infinity;
    for (let x = 100; x <= 400; x += 5) {
      const { value } = evaluateCurve(knots, x);
      expect(value).toBeGreaterThan(previous);
      previous = value;
    }
  });

  it('reproduces every point of a multi-point fit exactly', () => {
    const points: CurvePoint[] = [
      { x: 150, y: 160 },
      { x: 250, y: 245 },
      { x: 310, y: 320 },
      { x: 370, y: 366 },
    ];
    const knots = prepareKnots(points);
    for (const point of points) {
      expect(evaluateCurve(knots, point.x).value).toBeCloseTo(point.y, 12);
    }
    expect(curveRmsResidual(points)).toBeCloseTo(0, 12);
  });

  it('stays monotonic across a multi-point fit', () => {
    const knots = prepareKnots([
      { x: 150, y: 160 },
      { x: 250, y: 245 },
      { x: 310, y: 320 },
      { x: 370, y: 366 },
    ]);
    let previous = -Infinity;
    for (let x = 150; x <= 370; x += 1) {
      const { value } = evaluateCurve(knots, x);
      expect(value).toBeGreaterThanOrEqual(previous);
      previous = value;
    }
  });

  it('holds the end value flat past the outermost points', () => {
    const knots = prepareKnots([
      { x: 100, y: 110 },
      { x: 400, y: 380 },
    ]);
    expect(evaluateCurve(knots, 50, 'flat').value).toBe(110);
    expect(evaluateCurve(knots, 900, 'flat').value).toBe(380);
    expect(evaluateCurve(knots, 50, 'flat').extrapolated).toBe(true);
    expect(evaluateCurve(knots, 900, 'flat').extrapolated).toBe(true);
  });

  it('continues the end slope when asked, without accelerating away', () => {
    const knots = prepareKnots([
      { x: 100, y: 110 },
      { x: 400, y: 380 },
    ]);
    const slope = (380 - 110) / (400 - 100);
    expect(evaluateCurve(knots, 500, 'slope').value).toBeCloseTo(380 + slope * 100, 10);
    // Linear, not polynomial: doubling the distance doubles the offset.
    const near = evaluateCurve(knots, 500, 'slope').value - 380;
    const far = evaluateCurve(knots, 600, 'slope').value - 380;
    expect(far).toBeCloseTo(near * 2, 10);
  });

  it('averages duplicate measurements of the same input', () => {
    const knots = prepareKnots([
      { x: 200, y: 100 },
      { x: 200, y: 120 },
      { x: 300, y: 300 },
    ]);
    expect(evaluateCurve(knots, 200).value).toBeCloseTo(110, 12);
  });

  it('forces a self-contradicting calibration set to stay monotonic', () => {
    // The user calibrated against a warmer source but measured it cooler.
    // The fit must not fold back on itself and report two answers for one
    // reading.
    const points: CurvePoint[] = [
      { x: 100, y: 100 },
      { x: 200, y: 300 },
      { x: 300, y: 150 },
      { x: 400, y: 400 },
    ];
    const knots = prepareKnots(points);
    for (let i = 1; i < knots.length; i++) {
      expect(knots[i]!.y).toBeGreaterThanOrEqual(knots[i - 1]!.y);
    }
    // The offending pair is pooled to their mean, so the residuals are
    // non-zero and visible on the calibration screen.
    const residuals = curveResiduals(points);
    expect(Math.abs(residuals[1]!)).toBeGreaterThan(0);
    expect(Math.abs(residuals[2]!)).toBeGreaterThan(0);
  });

  it('handles a single point and an empty set without producing NaN silently', () => {
    expect(evaluateCurve(prepareKnots([{ x: 200, y: 250 }]), 999).value).toBe(250);
    expect(evaluateCurve(prepareKnots([{ x: 200, y: 250 }]), 999).extrapolated).toBe(true);
    expect(Number.isNaN(evaluateCurve([], 100).value)).toBe(true);
    expect(evaluateCurve([], 100).extrapolated).toBe(true);
  });
});

describe('mired-space calibration behaves evenly across the range', () => {
  it('applies the same perceptual correction at both ends', () => {
    // A fit in Kelvin would push the tungsten end far harder than the
    // daylight end. In mired the correction is a constant offset.
    const profile = createProfile({ name: 'Mired test', mode: 'raw' });
    const trimmed = withFieldTrim(profile, 2700, 2800);
    const miredDelta = kelvinToMired(2800) - kelvinToMired(2700);

    const warm = applyCalibration(trimmed, { kelvin: 2700, tint: 0 });
    expect(warm.kelvin).toBeCloseTo(2800, 6);

    const cool = applyCalibration(trimmed, { kelvin: 6500, tint: 0 });
    const expectedCool = miredToKelvin(kelvinToMired(6500) + miredDelta);
    expect(cool.kelvin).toBeCloseTo(expectedCool, 6);

    // The same mired step is a much smaller Kelvin step at the daylight end,
    // which is the whole point.
    expect(cool.kelvin - 6500).toBeGreaterThan(400);
    expect(cool.kelvin - 6500).toBeLessThan(700);
  });
});

describe('raw-mode calibration profiles', () => {
  const base = createProfile({ name: 'ProRAW / iPhone', mode: 'raw' });

  function point(measuredKelvin: number, referenceKelvin: number) {
    return {
      measured: kelvinToMired(measuredKelvin),
      referenceKelvin,
      measuredTint: 0,
      referenceTint: 0,
      label: `${referenceKelvin} K`,
    };
  }

  it('reports uncalibrated when there is nothing stored', () => {
    const result = applyCalibration(base, { kelvin: 4000, tint: 5 });
    expect(result.calibrated).toBe(false);
    expect(result.kelvin).toBeCloseTo(4000, 9);
    expect(result.tint).toBeCloseTo(5, 9);
  });

  it('passes the reading through untouched with no profile at all', () => {
    const result = applyCalibration(null, { kelvin: 4000, tint: 5 });
    expect(result.calibrated).toBe(false);
    expect(result.profileName).toBeNull();
    expect(result.kelvin).toBe(4000);
  });

  it('treats a single point as an offset, not as a fixed answer', () => {
    const profile = addPoint(base, point(3100, 3200));
    // The calibrated source reads correctly...
    expect(applyCalibration(profile, { kelvin: 3100, tint: 0 }).kelvin).toBeCloseTo(3200, 6);
    // ...and a different light is shifted by the same mired offset, not
    // reported as 3200 K.
    const other = applyCalibration(profile, { kelvin: 5000, tint: 0 });
    expect(other.kelvin).not.toBeCloseTo(3200, 0);
    expect(other.kelvin).toBeGreaterThan(5000);
  });

  it('reproduces both reference points of a two-point fit exactly', () => {
    const profile = addPoint(addPoint(base, point(2800, 2700)), point(6300, 6500));
    expect(applyCalibration(profile, { kelvin: 2800, tint: 0 }).kelvin).toBeCloseTo(2700, 6);
    expect(applyCalibration(profile, { kelvin: 6300, tint: 0 }).kelvin).toBeCloseTo(6500, 6);
    expect(applyCalibration(profile, { kelvin: 2800, tint: 0 }).extrapolated).toBe(false);
  });

  it('interpolates monotonically between calibration points', () => {
    const profile = addPoint(addPoint(base, point(2800, 2700)), point(6300, 6500));
    let previous = 0;
    for (let kelvin = 2800; kelvin <= 6300; kelvin += 50) {
      const { kelvin: corrected } = applyCalibration(profile, { kelvin, tint: 0 });
      expect(corrected).toBeGreaterThan(previous);
      previous = corrected;
    }
  });

  it('flags readings outside the calibrated span', () => {
    const profile = addPoint(addPoint(base, point(2800, 2700)), point(6300, 6500));
    expect(applyCalibration(profile, { kelvin: 4000, tint: 0 }).extrapolated).toBe(false);
    expect(applyCalibration(profile, { kelvin: 9000, tint: 0 }).extrapolated).toBe(true);
    expect(applyCalibration(profile, { kelvin: 2000, tint: 0 }).extrapolated).toBe(true);
  });

  it('holds the correction flat past the ends instead of running away', () => {
    const profile = addPoint(addPoint(base, point(2800, 2700)), point(6300, 6500));
    const atEnd = applyCalibration(profile, { kelvin: 6300, tint: 0 }).kelvin;
    const beyond = applyCalibration(profile, { kelvin: 20000, tint: 0 }).kelvin;
    expect(beyond).toBeCloseTo(atEnd, 6);
  });

  it('stacks a field trim on top of the fitted curve', () => {
    const profile = withFieldTrim(
      addPoint(addPoint(base, point(2800, 2700)), point(6300, 6500)),
      2700,
      2750,
    );
    expect(applyCalibration(profile, { kelvin: 2800, tint: 0 }).kelvin).toBeCloseTo(2750, 3);
  });

  it('corrects tint independently of temperature', () => {
    const profile = withTintOffset(base, 4, -2);
    const result = applyCalibration(profile, { kelvin: 5000, tint: 4 });
    expect(result.tint).toBeCloseTo(-2, 9);
    expect(result.kelvin).toBeCloseTo(5000, 9);
    expect(result.calibrated).toBe(true);
  });

  it('fits a tint offset from stored points', () => {
    let profile = base;
    profile = addPoint(profile, {
      measured: kelvinToMired(3000),
      referenceKelvin: 3000,
      measuredTint: 6,
      referenceTint: 0,
      label: 'a',
    });
    profile = addPoint(profile, {
      measured: kelvinToMired(5000),
      referenceKelvin: 5000,
      measuredTint: 4,
      referenceTint: 0,
      label: 'b',
    });
    expect(fitTintOffset(profile)).toBeCloseTo(-5, 9);
  });

  it('reports per-point residuals in both mired and Kelvin', () => {
    const profile = addPoint(addPoint(base, point(2800, 2700)), point(6300, 6500));
    const residuals = profileResiduals(profile);
    expect(residuals).toHaveLength(2);
    for (const residual of residuals) {
      expect(Math.abs(residual.miredResidual)).toBeLessThan(1e-9);
      expect(Math.abs(residual.kelvinResidual)).toBeLessThan(1e-6);
    }
  });

  it('surfaces residuals when calibration points disagree', () => {
    let profile = base;
    profile = addPoint(profile, point(3000, 3000));
    profile = addPoint(profile, point(4000, 6000));
    profile = addPoint(profile, point(5000, 3500));
    const residuals = profileResiduals(profile);
    const worst = Math.max(...residuals.map((r) => Math.abs(r.kelvinResidual)));
    expect(worst).toBeGreaterThan(100);
  });

  it('drops an individual point', () => {
    const profile = addPoint(addPoint(base, point(2800, 2700)), point(6300, 6500));
    const trimmed = removePoint(profile, profile.points[0]!.id);
    expect(trimmed.points).toHaveLength(1);
    expect(trimmed.points[0]!.referenceKelvin).toBe(6500);
  });
});

describe('live-mode calibration profiles', () => {
  const base = createProfile({ name: 'Passport / iPhone 15', mode: 'live', cardId: 'cc-passport' });

  function featurePoint(feature: number, referenceKelvin: number) {
    return {
      measured: feature,
      referenceKelvin,
      measuredTint: 0,
      referenceTint: 0,
      label: `${referenceKelvin} K`,
    };
  }

  it('refuses to report a temperature with no calibration, because the feature is not one', () => {
    const result = applyCalibration(base, { kelvin: Number.NaN, tint: 0, feature: 0.4 });
    expect(result.calibrated).toBe(false);
    expect(Number.isNaN(result.kelvin)).toBe(true);
  });

  it('maps the feature to the reference temperatures exactly at both points', () => {
    const profile = addPoint(addPoint(base, featurePoint(0.2, 5600)), featurePoint(0.9, 3200));
    expect(applyCalibration(profile, { kelvin: 0, tint: 0, feature: 0.2 }).kelvin).toBeCloseTo(
      5600,
      6,
    );
    expect(applyCalibration(profile, { kelvin: 0, tint: 0, feature: 0.9 }).kelvin).toBeCloseTo(
      3200,
      6,
    );
  });

  it('interpolates monotonically in feature space', () => {
    const profile = addPoint(addPoint(base, featurePoint(0.2, 5600)), featurePoint(0.9, 3200));
    let previousMired = 0;
    for (let feature = 0.2; feature <= 0.9; feature += 0.05) {
      const { kelvin } = applyCalibration(profile, { kelvin: 0, tint: 0, feature });
      const mired = kelvinToMired(kelvin);
      expect(mired).toBeGreaterThan(previousMired);
      previousMired = mired;
    }
  });

  it('extrapolates along the end slope rather than collapsing to one temperature', () => {
    const profile = addPoint(addPoint(base, featurePoint(0.2, 5600)), featurePoint(0.9, 3200));
    const beyond = applyCalibration(profile, { kelvin: 0, tint: 0, feature: 1.1 });
    expect(beyond.extrapolated).toBe(true);
    // Warmer than the warmest calibration point, not pinned to it.
    expect(beyond.kelvin).toBeLessThan(3200);
    expect(beyond.kelvin).toBeGreaterThan(1500);
  });

  it('reports nothing when the feature could not be computed', () => {
    const profile = addPoint(addPoint(base, featurePoint(0.2, 5600)), featurePoint(0.9, 3200));
    const result = applyCalibration(profile, { kelvin: 0, tint: 0 });
    expect(Number.isNaN(result.kelvin)).toBe(true);
    expect(result.calibrated).toBe(false);
  });
});
