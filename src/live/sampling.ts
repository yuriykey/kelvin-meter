/**
 * Sampling patch regions out of a video frame.
 *
 * Pixels arriving from a canvas readback are sRGB-encoded. They are
 * linearised before any averaging happens, because averaging encoded values
 * is not the average of the light — the ~2.2 gamma means a region that is
 * half 20% grey and half 80% grey averages to the wrong radiance by several
 * per cent, and the ratios this mode depends on inherit that error.
 *
 * A trimmed mean is used rather than a plain mean so a dust speck, a
 * specular glint or a sliver of the neighbouring patch does not drag the
 * sample.
 */

import { SRGB_DECODE_LUT } from '../color/index.ts';

/** Code value at or above which a channel is treated as clipped. */
export const CLIPPING_CODE = 250;
/** Below 10% of encoded range there is not enough signal to trust a ratio. */
export const LOW_SIGNAL_CODE = 26;
/** Fraction of pixels trimmed from each end before averaging. */
const TRIM_FRACTION = 0.15;

export interface PatchSample {
  /** Linear-light channel means, sRGB decoded. */
  readonly linear: readonly [number, number, number];
  /** Encoded channel means, 0-255, for threshold checks and display. */
  readonly encoded: readonly [number, number, number];
  /** Fraction of pixels with any channel at or above the clipping threshold. */
  readonly clippedFraction: number;
  readonly pixelCount: number;
}

export type PatchProblem = 'clipping' | 'too-dark' | 'no-pixels';

export interface PatchQuality {
  readonly ok: boolean;
  readonly problem: PatchProblem | null;
}

/** Normalised sample rectangle, 0..1 in both axes. */
export interface SampleRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Mean channel values over a rectangle of an RGBA buffer.
 *
 * @param data   RGBA bytes, as returned by `getImageData`.
 * @param width  Buffer width in pixels.
 * @param height Buffer height in pixels.
 * @param rect   Region to sample, normalised to the buffer.
 */
export function samplePatch(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  rect: SampleRect,
): PatchSample {
  const x0 = Math.max(0, Math.round(rect.x * width));
  const y0 = Math.max(0, Math.round(rect.y * height));
  const x1 = Math.min(width, Math.round((rect.x + rect.width) * width));
  const y1 = Math.min(height, Math.round((rect.y + rect.height) * height));

  const count = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  if (count === 0) {
    return { linear: [0, 0, 0], encoded: [0, 0, 0], clippedFraction: 0, pixelCount: 0 };
  }

  const channels: [number[], number[], number[]] = [[], [], []];
  let clipped = 0;

  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const index = (y * width + x) * 4;
      const r = data[index]!;
      const g = data[index + 1]!;
      const b = data[index + 2]!;
      channels[0].push(r);
      channels[1].push(g);
      channels[2].push(b);
      if (r >= CLIPPING_CODE || g >= CLIPPING_CODE || b >= CLIPPING_CODE) clipped++;
    }
  }

  const encoded: [number, number, number] = [0, 0, 0];
  const linear: [number, number, number] = [0, 0, 0];

  for (let channel = 0; channel < 3; channel++) {
    const values = channels[channel]!;
    values.sort((a, b) => a - b);
    const trim = Math.floor(values.length * TRIM_FRACTION);
    const from = trim;
    const to = Math.max(from + 1, values.length - trim);

    let encodedSum = 0;
    let linearSum = 0;
    for (let i = from; i < to; i++) {
      const code = values[i]!;
      encodedSum += code;
      linearSum += SRGB_DECODE_LUT[code]!;
    }
    const n = to - from;
    encoded[channel] = encodedSum / n;
    linear[channel] = linearSum / n;
  }

  return { linear, encoded, clippedFraction: clipped / count, pixelCount: count };
}

/**
 * Whether a sample carries enough clean signal to be used.
 *
 * Clipping is rejected outright: a clipped channel has lost the ratio the
 * whole method rests on. Low signal is rejected because sensor noise and the
 * toe of the tone curve both dominate down there.
 */
export function assessPatch(sample: PatchSample): PatchQuality {
  if (sample.pixelCount === 0) return { ok: false, problem: 'no-pixels' };
  if (sample.clippedFraction > 0.02) return { ok: false, problem: 'clipping' };
  if (sample.encoded.some((value) => value >= CLIPPING_CODE)) {
    return { ok: false, problem: 'clipping' };
  }
  if (sample.encoded.every((value) => value < LOW_SIGNAL_CODE)) {
    return { ok: false, problem: 'too-dark' };
  }
  return { ok: true, problem: null };
}

/**
 * Guide box layout: four square sample regions in a row across the middle of
 * the frame.
 *
 * They are kept adjacent and the same size on purpose. iOS applies spatially
 * varying tone mapping, which the ratio method does not cancel — the further
 * apart the patches sit, and the more the local brightness differs between
 * them, the more of that variation leaks into the reading.
 */
export function defaultGuideRects(count = 4): SampleRect[] {
  const size = 0.12;
  const gap = 0.03;
  const totalWidth = count * size + (count - 1) * gap;
  const startX = (1 - totalWidth) / 2;
  const y = 0.5 - size / 2;
  return Array.from({ length: count }, (_, index) => ({
    x: startX + index * (size + gap),
    y,
    width: size,
    height: size,
  }));
}
