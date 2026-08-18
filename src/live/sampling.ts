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
 * Geometry of the card-alignment grid.
 *
 * The user lines the whole card up inside a grid drawn over the preview, and
 * the app samples the cells it needs. Generating the sample rectangles from
 * the card's own row and column numbers is what keeps the boxes and the
 * written instructions from drifting apart — they come from one source.
 */
export interface CardGrid {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly rows: number;
  readonly columns: number;
}

/** Fraction of the frame the grid is allowed to occupy. */
const GRID_MARGIN = 0.9;
/** Fraction of a cell that is actually sampled, keeping clear of the borders. */
export const CELL_SAMPLE_FRACTION = 0.5;

/**
 * Lays a rows x columns grid of visually square cells over the frame.
 *
 * `frameAspect` is the frame's width divided by its height. Cells are square
 * on screen rather than in normalised coordinates, because a grid of squashed
 * rectangles is not something you can line a card up against.
 */
export function cardGrid(rows: number, columns: number, frameAspect: number): CardGrid {
  const safeAspect = Number.isFinite(frameAspect) && frameAspect > 0 ? frameAspect : 4 / 3;
  // Cell width w in normalised units; height must be w * aspect to look square.
  const widthLimited = GRID_MARGIN / columns;
  const heightLimited = GRID_MARGIN / (rows * safeAspect);
  const cellWidth = Math.min(widthLimited, heightLimited);
  const cellHeight = cellWidth * safeAspect;

  const width = cellWidth * columns;
  const height = cellHeight * rows;
  return { x: (1 - width) / 2, y: (1 - height) / 2, width, height, rows, columns };
}

/** Sample rectangle for one 1-based cell of the grid. */
export function cellRect(
  grid: CardGrid,
  row: number,
  column: number,
  fraction = CELL_SAMPLE_FRACTION,
): SampleRect {
  const cellWidth = grid.width / grid.columns;
  const cellHeight = grid.height / grid.rows;
  const centreX = grid.x + (column - 0.5) * cellWidth;
  const centreY = grid.y + (row - 0.5) * cellHeight;
  const width = cellWidth * fraction;
  const height = cellHeight * fraction;
  return { x: centreX - width / 2, y: centreY - height / 2, width, height };
}

/** Outline of one whole cell, for drawing the grid. */
export function cellOutline(grid: CardGrid, row: number, column: number): SampleRect {
  return cellRect(grid, row, column, 1);
}
