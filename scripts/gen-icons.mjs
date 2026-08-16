#!/usr/bin/env node
/**
 * Draws the app icons.
 *
 * Everything is rasterised here rather than fetched or converted, so the
 * build has no image dependency and the icons are reproducible. The design is
 * a bold K filled with the white-balance ramp — amber at the warm end,
 * blue at the cool end — which is the one idea the app is about and stays
 * legible down to 16 px.
 *
 * Run with: npm run icons
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodePng } from './lib/png.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const iconsDir = join(here, '..', 'public', 'icons');
const publicDir = join(here, '..', 'public');

const BACKGROUND = [11, 15, 20];
const WARM = [255, 172, 88];
const MID = [246, 244, 240];
const COOL = [122, 176, 255];

function clamp(value, low, high) {
  return value < low ? low : value > high ? high : value;
}

function mix(a, b, t) {
  return [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
  ];
}

/** The white balance ramp, sampled at 0 (warm) to 1 (cool). */
function rampColour(t) {
  const clamped = clamp(t, 0, 1);
  return clamped < 0.5
    ? mix(WARM, MID, clamped * 2)
    : mix(MID, COOL, (clamped - 0.5) * 2);
}

function smoothstep(edge0, edge1, x) {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

/** Distance from point p to the line segment ab. */
function segmentDistance(px, py, ax, ay, bx, by) {
  const pax = px - ax;
  const pay = py - ay;
  const bax = bx - ax;
  const bay = by - ay;
  const lengthSquared = bax * bax + bay * bay;
  const h = lengthSquared === 0 ? 0 : clamp((pax * bax + pay * bay) / lengthSquared, 0, 1);
  return Math.hypot(pax - bax * h, pay - bay * h);
}

/** Signed distance to a rounded square centred on (0.5, 0.5). */
function roundedSquareDistance(px, py, half, radius) {
  const qx = Math.abs(px - 0.5) - (half - radius);
  const qy = Math.abs(py - 0.5) - (half - radius);
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  return outside + Math.min(Math.max(qx, qy), 0) - radius;
}

/**
 * @param {number} size      pixel dimension
 * @param {object} options
 * @param {boolean} options.maskable  full-bleed background, artwork inside the
 *   safe zone so a platform mask cannot crop it
 * @param {boolean} options.rounded   draw a rounded-square plate
 */
function drawIcon(size, { maskable = false, rounded = true } = {}) {
  const rgba = new Uint8Array(size * size * 4);
  // Supersample: a 3x3 grid per pixel is enough to keep the diagonals of the
  // K clean at 32 px without a real rasteriser.
  const samples = 3;
  const step = 1 / (samples + 1);

  // Maskable icons must survive a circular crop at 80% of the canvas, so the
  // artwork shrinks and the background covers everything.
  const scale = maskable ? 0.62 : 0.84;
  const plateHalf = maskable ? 0.5 : 0.5;
  const plateRadius = maskable ? 0 : 0.115;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;

      for (let sy = 1; sy <= samples; sy++) {
        for (let sx = 1; sx <= samples; sx++) {
          const px = (x + sx * step) / size;
          const py = (y + sy * step) / size;
          const [sr, sg, sb, sa] = shade(px, py, scale, {
            maskable,
            rounded,
            plateHalf,
            plateRadius,
            size,
          });
          r += sr;
          g += sg;
          b += sb;
          a += sa;
        }
      }

      const count = samples * samples;
      const index = (y * size + x) * 4;
      rgba[index] = Math.round(r / count);
      rgba[index + 1] = Math.round(g / count);
      rgba[index + 2] = Math.round(b / count);
      rgba[index + 3] = Math.round(a / count);
    }
  }

  return rgba;
}

function shade(px, py, scale, { maskable, rounded, plateHalf, plateRadius, size }) {
  const antialias = 1.2 / size;

  // Background plate.
  let plateAlpha = 1;
  if (rounded && !maskable) {
    const distance = roundedSquareDistance(px, py, plateHalf, plateRadius);
    plateAlpha = 1 - smoothstep(-antialias, antialias, distance);
  }
  if (plateAlpha <= 0) return [0, 0, 0, 0];

  let colour = [...BACKGROUND];

  // A faint ramp wash across the plate so the icon is not flat black.
  const wash = 0.055 * smoothstep(0.85, 0.1, py);
  colour = mix(colour, rampColour(px), wash);

  // The K, drawn in normalised coordinates then scaled about the centre.
  const kx = (px - 0.5) / scale + 0.5;
  const ky = (py - 0.5) / scale + 0.5;

  const top = 0.24;
  const bottom = 0.76;
  const stemX = 0.335;
  const armX = 0.70;
  const junctionY = 0.5;
  const junctionX = 0.375;
  const thickness = 0.072;

  const distance = Math.min(
    segmentDistance(kx, ky, stemX, top, stemX, bottom),
    segmentDistance(kx, ky, junctionX, junctionY, armX, top),
    segmentDistance(kx, ky, junctionX, junctionY, armX, bottom),
  );

  const glyphAlpha = 1 - smoothstep(thickness - antialias, thickness + antialias, distance);
  if (glyphAlpha > 0) {
    // Fill the glyph with the ramp so the warm end sits left, cool end right.
    const rampPosition = (kx - stemX) / (armX - stemX);
    colour = mix(colour, rampColour(rampPosition), glyphAlpha);
  }

  return [colour[0], colour[1], colour[2], 255 * plateAlpha];
}

function write(path, size, options) {
  const png = encodePng(size, size, drawIcon(size, options));
  writeFileSync(path, png);
  console.log(`  ${path.split('/').slice(-2).join('/')}  ${size}x${size}  ${png.length} bytes`);
}

mkdirSync(iconsDir, { recursive: true });
console.log('Drawing icons:');

write(join(iconsDir, 'icon-192.png'), 192, {});
write(join(iconsDir, 'icon-512.png'), 512, {});
write(join(iconsDir, 'icon-maskable-192.png'), 192, { maskable: true });
write(join(iconsDir, 'icon-maskable-512.png'), 512, { maskable: true });
write(join(iconsDir, 'favicon-32.png'), 32, {});
write(join(iconsDir, 'favicon-16.png'), 16, {});

// iOS ignores transparency and applies its own mask, so the apple-touch-icon
// is drawn square and full-bleed.
write(join(publicDir, 'apple-touch-icon.png'), 180, { rounded: false });

console.log('Done.');
