/**
 * Monotonic piecewise-linear fitting in mired space.
 *
 * Everything is fitted in reciprocal megakelvin, never in Kelvin. Mired is
 * roughly perceptually even for colour temperature: the step from 2700 K to
 * 2800 K is a visible change, the step from 9000 K to 9100 K is not, and in
 * mired those are 13.2 and 1.2 respectively. A straight line fitted in mired
 * behaves sensibly across the whole range; the same line fitted in Kelvin is
 * dominated by the daylight end and is badly wrong at the tungsten end.
 *
 * Nothing here is a polynomial. Past the outermost calibration points the
 * curves stop bending, because a polynomial run off the end of its data is
 * how a calibration turns a 6500 K window into a 12000 K one.
 */

export interface CurvePoint {
  /** Input value: measured mired for a correction curve, or a live-mode feature. */
  readonly x: number;
  /** Output value: reference mired for a correction curve. */
  readonly y: number;
}

export interface CurveEvaluation {
  readonly value: number;
  /** Input fell outside the span of the calibration points. */
  readonly extrapolated: boolean;
}

/**
 * Sorts by x, averages duplicate x values, then enforces a non-decreasing y
 * by pool-adjacent-violators. A calibration set that disagrees with itself
 * (two sources where the warmer one measured cooler) would otherwise produce
 * a curve that folds back on itself and reports two temperatures for one
 * reading.
 */
export function prepareKnots(points: readonly CurvePoint[]): CurvePoint[] {
  if (points.length === 0) return [];

  const sorted = [...points].sort((a, b) => a.x - b.x);

  // Average duplicate inputs.
  const merged: { x: number; sum: number; count: number }[] = [];
  for (const point of sorted) {
    const last = merged[merged.length - 1];
    if (last && Math.abs(last.x - point.x) < 1e-9) {
      last.sum += point.y;
      last.count += 1;
    } else {
      merged.push({ x: point.x, sum: point.y, count: 1 });
    }
  }

  // Pool adjacent violators: the standard isotonic regression, which is the
  // least-squares best non-decreasing fit to the data.
  const blocks: { y: number; weight: number; from: number; to: number }[] = [];
  merged.forEach((item, index) => {
    blocks.push({ y: item.sum / item.count, weight: item.count, from: index, to: index });
    while (blocks.length > 1) {
      const current = blocks[blocks.length - 1]!;
      const previous = blocks[blocks.length - 2]!;
      if (previous.y <= current.y) break;
      const weight = previous.weight + current.weight;
      previous.y = (previous.y * previous.weight + current.y * current.weight) / weight;
      previous.weight = weight;
      previous.to = current.to;
      blocks.pop();
    }
  });

  const knots: CurvePoint[] = [];
  for (const block of blocks) {
    for (let i = block.from; i <= block.to; i++) {
      knots.push({ x: merged[i]!.x, y: block.y });
    }
  }
  return knots;
}

/**
 * Piecewise-linear interpolation through the knots.
 *
 * `extrapolation` controls what happens beyond the outermost knots:
 *   'flat'  — hold the end value. Correct for a correction curve, where the
 *             sensible behaviour past the last calibration point is to keep
 *             applying the last known correction.
 *   'slope' — continue the end segment's slope. Needed where the curve maps
 *             an abstract feature to a temperature and there is no identity
 *             baseline to fall back on; flat would report one single
 *             temperature for every out-of-range reading.
 */
export function evaluateCurve(
  knots: readonly CurvePoint[],
  x: number,
  extrapolation: 'flat' | 'slope' = 'flat',
): CurveEvaluation {
  if (knots.length === 0) return { value: Number.NaN, extrapolated: true };

  const first = knots[0]!;
  const last = knots[knots.length - 1]!;

  if (knots.length === 1) return { value: first.y, extrapolated: x !== first.x };

  if (x <= first.x) {
    if (x === first.x) return { value: first.y, extrapolated: false };
    if (extrapolation === 'flat') return { value: first.y, extrapolated: true };
    const second = knots[1]!;
    const slope = segmentSlope(first, second);
    return { value: first.y + slope * (x - first.x), extrapolated: true };
  }

  if (x >= last.x) {
    if (x === last.x) return { value: last.y, extrapolated: false };
    if (extrapolation === 'flat') return { value: last.y, extrapolated: true };
    const penultimate = knots[knots.length - 2]!;
    const slope = segmentSlope(penultimate, last);
    return { value: last.y + slope * (x - last.x), extrapolated: true };
  }

  for (let i = 0; i < knots.length - 1; i++) {
    const a = knots[i]!;
    const b = knots[i + 1]!;
    if (x >= a.x && x <= b.x) {
      if (b.x === a.x) return { value: (a.y + b.y) / 2, extrapolated: false };
      const t = (x - a.x) / (b.x - a.x);
      return { value: a.y + t * (b.y - a.y), extrapolated: false };
    }
  }

  /* istanbul ignore next -- the loop covers the whole interior span */
  return { value: last.y, extrapolated: true };
}

function segmentSlope(a: CurvePoint, b: CurvePoint): number {
  if (b.x === a.x) return 0;
  return (b.y - a.y) / (b.x - a.x);
}

/** Residual of each supplied point against the fitted curve, in the curve's y units. */
export function curveResiduals(
  points: readonly CurvePoint[],
  extrapolation: 'flat' | 'slope' = 'flat',
): number[] {
  const knots = prepareKnots(points);
  return points.map((point) => evaluateCurve(knots, point.x, extrapolation).value - point.y);
}

/** Root-mean-square residual, a single number for "how well does this fit". */
export function curveRmsResidual(
  points: readonly CurvePoint[],
  extrapolation: 'flat' | 'slope' = 'flat',
): number {
  if (points.length === 0) return 0;
  const residuals = curveResiduals(points, extrapolation);
  const sum = residuals.reduce((total, r) => total + r * r, 0);
  return Math.sqrt(sum / residuals.length);
}
