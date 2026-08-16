/**
 * The AWB-invariant ratio method.
 *
 * iOS gives no way to lock white balance, so every frame has already been
 * neutralised. Pointing the camera at a grey card and reading its colour is
 * therefore worthless by construction: auto white balance makes grey cards
 * grey, that is its entire job.
 *
 * What survives is this. Auto white balance applies approximately global
 * per-channel gains g_R, g_G, g_B. For two patches p and q in the same frame
 * the recorded values are
 *
 *     V_p,c = g_c . S_p,c        where S_p,c is the true sensor response
 *
 * so the ratio V_p,c / V_q,c = S_p,c / S_q,c has the gain divided out. The
 * ratio still depends on the illuminant's spectrum, because S is an integral
 * of illuminant times patch reflectance times channel sensitivity. That
 * residual dependence is the signal.
 *
 * The warmth feature contrasts how the red and blue channels each see the
 * warm patch relative to the cool one:
 *
 *     F = ln(V_warm,R / V_cool,R) - ln(V_warm,B / V_cool,B)
 *
 * Under a warm illuminant the warm patch gains on the cool one in red and
 * loses in blue, so F rises. It is monotonic in colour temperature but its
 * scale is a property of the sensor and the card, which is why it has to be
 * calibrated and cannot be shipped with a factory curve.
 *
 * This is a genuinely weak signal riding on an undocumented tone curve. It is
 * labelled approximate everywhere in the UI for good reason.
 */

import type { PatchRole } from './cards.ts';
import { assessPatch, type PatchProblem, type PatchSample } from './sampling.ts';

export interface PatchReading {
  readonly role: PatchRole;
  readonly sample: PatchSample;
}

export type FeatureProblem = PatchProblem | 'missing-patch' | 'degenerate';

export interface FeatureResult {
  /** Warmth feature: rises with colour temperature. Feeds the calibration curve. */
  readonly warmth: number;
  /** Green/magenta feature, for the tint axis. */
  readonly greenness: number;
  readonly ok: boolean;
  readonly problems: readonly { role: PatchRole; problem: FeatureProblem }[];
}

/** Guards against log(0) and against dividing by a channel that read as black. */
const MIN_LINEAR = 1e-5;

function channel(sample: PatchSample, index: 0 | 1 | 2): number {
  return Math.max(MIN_LINEAR, sample.linear[index]!);
}

export function computeFeatures(readings: readonly PatchReading[]): FeatureResult {
  const byRole = new Map<PatchRole, PatchSample>();
  const problems: { role: PatchRole; problem: FeatureProblem }[] = [];

  for (const reading of readings) {
    const quality = assessPatch(reading.sample);
    if (!quality.ok) {
      problems.push({ role: reading.role, problem: quality.problem! });
      continue;
    }
    byRole.set(reading.role, reading.sample);
  }

  for (const role of ['warm', 'cool', 'green', 'neutral'] as const) {
    if (!byRole.has(role) && !problems.some((p) => p.role === role)) {
      problems.push({ role, problem: 'missing-patch' });
    }
  }

  const warm = byRole.get('warm');
  const cool = byRole.get('cool');
  const green = byRole.get('green');
  const neutral = byRole.get('neutral');

  if (!warm || !cool) {
    return { warmth: Number.NaN, greenness: Number.NaN, ok: false, problems };
  }

  // The AWB gains cancel here: each log ratio is between two patches in the
  // same frame and the same channel.
  const warmth =
    Math.log(channel(warm, 0) / channel(cool, 0)) -
    Math.log(channel(warm, 2) / channel(cool, 2));

  let greenness = Number.NaN;
  if (green && neutral) {
    // Green channel excess relative to the mean of red and blue, again as a
    // between-patch ratio so the gains drop out.
    greenness =
      Math.log(channel(green, 1) / channel(neutral, 1)) -
      0.5 *
        (Math.log(channel(green, 0) / channel(neutral, 0)) +
          Math.log(channel(green, 2) / channel(neutral, 2)));
  }

  const ok = problems.length === 0 && Number.isFinite(warmth);
  if (!Number.isFinite(warmth)) {
    problems.push({ role: 'warm', problem: 'degenerate' });
  }

  return { warmth, greenness, ok, problems };
}

/**
 * Rolling stability window.
 *
 * A live reading that swings frame to frame is telling you the scene is not
 * stable enough to measure — someone walked past, the auto exposure is
 * hunting, or the card is catching a moving reflection. That has to be
 * surfaced rather than averaged away.
 */
export class StabilityTracker {
  private readonly window: number[] = [];

  constructor(private readonly capacity = 12) {}

  push(value: number): void {
    if (!Number.isFinite(value)) return;
    this.window.push(value);
    if (this.window.length > this.capacity) this.window.shift();
  }

  clear(): void {
    this.window.length = 0;
  }

  get count(): number {
    return this.window.length;
  }

  get mean(): number {
    if (this.window.length === 0) return Number.NaN;
    return this.window.reduce((sum, value) => sum + value, 0) / this.window.length;
  }

  /** Sample standard deviation of the window. */
  get standardDeviation(): number {
    if (this.window.length < 2) return Number.NaN;
    const mean = this.mean;
    const sum = this.window.reduce((total, value) => total + (value - mean) ** 2, 0);
    return Math.sqrt(sum / (this.window.length - 1));
  }

  /** True once there is enough history to judge stability at all. */
  get ready(): boolean {
    return this.window.length >= Math.min(6, this.capacity);
  }
}
