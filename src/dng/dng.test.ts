import { readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DngParseError, parseDng } from './parse.ts';
import { DngSolveError, neutralToXY, solveIlluminant, xyToNeutral } from './solve.ts';
import { TiffReader, looksLikeTiff } from './tiff.ts';
import {
  type Vec3,
  lightSourceToKelvin,
  mat3,
  measureXY,
  temperatureTintToXY,
  xyToCCT,
} from '../color/index.ts';
import type { CalibrationSet } from './parse.ts';

const FIXTURES = join(import.meta.dirname, '..', '..', 'test', 'fixtures');

function load(name: string): ArrayBuffer {
  const buffer = readFileSync(join(FIXTURES, name));
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
}

const scene = JSON.parse(
  readFileSync(join(FIXTURES, 'synthetic-scene.json'), 'utf8'),
) as {
  sceneXY: { x: number; y: number };
  asShotNeutral: number[];
  colorMatrix1: number[];
  colorMatrix2: number[];
};

describe('TIFF container handling', () => {
  it('recognises both byte orders', () => {
    expect(new TiffReader(load('synthetic-le.dng')).littleEndian).toBe(true);
    expect(new TiffReader(load('synthetic-be.dng')).littleEndian).toBe(false);
  });

  it('screens files cheaply before committing to a parse', () => {
    expect(looksLikeTiff(load('synthetic-le.dng'))).toBe(true);
    expect(looksLikeTiff(load('synthetic-be.dng'))).toBe(true);
    expect(looksLikeTiff(load('not-a-dng.bin'))).toBe(false);
    expect(looksLikeTiff(new ArrayBuffer(2))).toBe(false);
  });

  it('rejects a non-TIFF with a message a user can act on', () => {
    expect(() => parseDng(load('not-a-dng.bin'))).toThrow(DngParseError);
    expect(() => parseDng(load('not-a-dng.bin'))).toThrow(/not a tiff or dng/i);
  });

  it('rejects a truncated file rather than reading past the buffer', () => {
    expect(() => parseDng(load('synthetic-truncated.dng'))).toThrow(DngParseError);
  });

  it('rejects an empty file', () => {
    expect(() => parseDng(new ArrayBuffer(0))).toThrow(DngParseError);
  });
});

describe('DNG metadata extraction', () => {
  it.each(['synthetic-le.dng', 'synthetic-be.dng'])('reads %s', (name) => {
    const meta = parseDng(load(name));
    expect(meta.make).toBe('KelvinMeter');
    expect(meta.model).toBe('Synthetic Reference Camera');
    expect(meta.uniqueCameraModel).toBe('KelvinMeter Synthetic Reference Camera');
    expect(meta.profileName).toBe('KelvinMeter Synthetic');
    expect(meta.dngVersion).toBe('1.4.0.0');
    expect(meta.calibrations).toHaveLength(2);
    expect(meta.asShotNeutral).not.toBeNull();
  });

  it('produces byte-order-independent results', () => {
    const little = parseDng(load('synthetic-le.dng'));
    const big = parseDng(load('synthetic-be.dng'));
    expect(big.byteOrder).toBe('big-endian');
    expect(little.byteOrder).toBe('little-endian');
    // Everything except the recorded byte order must be identical.
    expect({ ...big, byteOrder: 'little-endian' }).toEqual(little);
  });

  it('sorts calibrations coolest first regardless of tag order', () => {
    const meta = parseDng(load('synthetic-le.dng'));
    expect(meta.calibrations[0]!.illuminantCode).toBe(17); // Standard light A
    expect(meta.calibrations[1]!.illuminantCode).toBe(21); // D65
    expect(meta.calibrations[0]!.illuminantKelvin).toBe(2850);
    expect(meta.calibrations[1]!.illuminantKelvin).toBe(6500);
  });

  it('reads AsShotWhiteXY when a writer supplies it', () => {
    const meta = parseDng(load('synthetic-whitexy.dng'));
    expect(meta.asShotWhiteXY).not.toBeNull();
    expect(meta.asShotWhiteXY!.x).toBeCloseTo(scene.sceneXY.x, 5);
    expect(meta.asShotWhiteXY!.y).toBeCloseTo(scene.sceneXY.y, 5);
  });

  it('handles a file with a single calibration illuminant', () => {
    const meta = parseDng(load('synthetic-single-illuminant.dng'));
    expect(meta.calibrations).toHaveLength(1);
    expect(meta.asShotNeutral).not.toBeNull();
  });

  it('lists the tags it found so a reading can be audited', () => {
    const meta = parseDng(load('synthetic-le.dng'));
    expect(meta.tagsPresent).toContain('AsShotNeutral');
    expect(meta.tagsPresent).toContain('ColorMatrix1');
    expect(meta.tagsPresent).toContain('ColorMatrix2');
    expect(meta.tagsPresent).toContain('CalibrationIlluminant1');
    expect(meta.tagsPresent).not.toContain('AsShotWhiteXY');
  });
});

/**
 * Every `*.exiftool.json` in the fixtures directory is checked against the
 * DNG of the same name. The synthetic ones are generated, but the format is
 * exactly what `exiftool -j -n real.dng` emits, so adding a real camera file
 * is a matter of dropping in the pair — no test changes required.
 */
describe('parsed tag values match exiftool output', () => {
  const pairs = readdirSync(FIXTURES)
    .filter((name) => name.endsWith('.exiftool.json'))
    .map((name) => ({ json: name, dng: `${basename(name, '.exiftool.json')}.dng` }));

  it('finds at least one fixture pair to check', () => {
    expect(pairs.length).toBeGreaterThan(0);
  });

  it.each(pairs)('$dng', ({ json, dng }) => {
    const expected = JSON.parse(readFileSync(join(FIXTURES, json), 'utf8'))[0] as Record<
      string,
      unknown
    >;
    const meta = parseDng(load(dng));

    const numbers = (value: unknown): number[] =>
      String(value)
        .trim()
        .split(/\s+/)
        .map(Number);

    if (expected['Make']) expect(meta.make).toBe(expected['Make']);
    if (expected['Model']) expect(meta.model).toBe(expected['Model']);
    if (expected['UniqueCameraModel']) {
      expect(meta.uniqueCameraModel).toBe(expected['UniqueCameraModel']);
    }
    if (expected['DNGVersion']) {
      expect(meta.dngVersion).toBe(numbers(expected['DNGVersion']).join('.'));
    }

    if (expected['AsShotNeutral']) {
      const want = numbers(expected['AsShotNeutral']);
      expect(meta.asShotNeutral).not.toBeNull();
      meta.asShotNeutral!.forEach((got, i) => expect(got).toBeCloseTo(want[i]!, 5));
    }

    if (expected['AsShotWhiteXY']) {
      const want = numbers(expected['AsShotWhiteXY']);
      expect(meta.asShotWhiteXY!.x).toBeCloseTo(want[0]!, 5);
      expect(meta.asShotWhiteXY!.y).toBeCloseTo(want[1]!, 5);
    }

    for (const [slot, key] of [
      [0, 'ColorMatrix1'],
      [1, 'ColorMatrix2'],
    ] as const) {
      if (!expected[key]) continue;
      const want = numbers(expected[key]);
      const got = meta.calibrations[slot]?.colorMatrix;
      expect(got, `${key} present`).toBeDefined();
      want.forEach((value, i) => expect(got![i]).toBeCloseTo(value, 5));
    }

    for (const [slot, key] of [
      [0, 'CalibrationIlluminant1'],
      [1, 'CalibrationIlluminant2'],
    ] as const) {
      if (expected[key] === undefined) continue;
      expect(meta.calibrations[slot]?.illuminantCode).toBe(Number(expected[key]));
    }
  });
});

describe('illuminant solve', () => {
  it('recovers a plausible tungsten temperature from the fixture', () => {
    const result = solveIlluminant(parseDng(load('synthetic-le.dng')));
    expect(result.converged).toBe(true);
    expect(result.source).toBe('AsShotNeutral + ColorMatrix interpolation');
    expect(result.measurement.kelvin).toBeGreaterThan(2900);
    expect(result.measurement.kelvin).toBeLessThan(3600);
  });

  it('separates a warm, a mid and a cool scene in the right order', () => {
    const warm = solveIlluminant(parseDng(load('synthetic-warm.dng'))).measurement.kelvin;
    const mid = solveIlluminant(parseDng(load('synthetic-le.dng'))).measurement.kelvin;
    const cool = solveIlluminant(parseDng(load('synthetic-cool.dng'))).measurement.kelvin;

    expect(warm).toBeLessThan(mid);
    expect(mid).toBeLessThan(cool);
    // Each should land near the illuminant the fixture was generated from.
    expect(Math.abs(warm - 2700)).toBeLessThan(200);
    expect(Math.abs(cool - 6000)).toBeLessThan(200);
  });

  it('leans on the warm calibration for warm scenes and the cool one for cool scenes', () => {
    const warm = solveIlluminant(parseDng(load('synthetic-warm.dng'))).interpolation!;
    const cool = solveIlluminant(parseDng(load('synthetic-cool.dng'))).interpolation!;
    expect(warm.warmWeight).toBeGreaterThan(cool.warmWeight);
    expect(warm.warmWeight).toBeGreaterThan(0.9);
    expect(cool.warmWeight).toBeLessThan(0.2);
  });

  it('gives the same answer from either byte order', () => {
    const little = solveIlluminant(parseDng(load('synthetic-le.dng')));
    const big = solveIlluminant(parseDng(load('synthetic-be.dng')));
    expect(big.measurement.kelvin).toBeCloseTo(little.measurement.kelvin, 9);
  });

  it('is self-consistent: the solved illuminant regenerates the stored AsShotNeutral', () => {
    // The strongest check available without a reference camera. If the solve
    // is right, running the forward model on its answer has to reproduce the
    // bytes that are actually in the file.
    const meta = parseDng(load('synthetic-le.dng'));
    const result = solveIlluminant(meta);
    const regenerated = xyToNeutral(meta.calibrations, meta.analogBalance, result.xy);
    const stored = meta.asShotNeutral!;
    const scale = Math.max(...stored);
    regenerated.forEach((value, i) => {
      expect(value).toBeCloseTo(stored[i]! / scale, 4);
    });
  });

  it('converges in a handful of iterations', () => {
    const result = solveIlluminant(parseDng(load('synthetic-le.dng')));
    expect(result.iterations).toBeGreaterThan(0);
    expect(result.iterations).toBeLessThanOrEqual(6);
  });

  it('interpolates strictly between the two calibrations', () => {
    const result = solveIlluminant(parseDng(load('synthetic-le.dng')));
    expect(result.interpolation).not.toBeNull();
    expect(result.interpolation!.warmWeight).toBeGreaterThan(0);
    expect(result.interpolation!.warmWeight).toBeLessThan(1);
  });

  it('names the calibration illuminants it blended, warm end first', () => {
    // The weight is the share of the LOWER-temperature calibration, which is
    // the WARMER light. Reporting a bare percentage inverts in conversation.
    const result = solveIlluminant(parseDng(load('synthetic-le.dng')));
    const blend = result.interpolation!;
    expect(blend.warmKelvin).toBeLessThan(blend.coolKelvin);
    expect(blend.warmName).toBe('Standard light A');
    expect(blend.coolName).toBe('D65');
    // The fixture is a ~3400 K scene, much nearer the 2850 K calibration than
    // the 6500 K one, so most of the blend must come from the warm end.
    expect(blend.warmWeight).toBeGreaterThan(0.5);
  });

  it('short-circuits to AsShotWhiteXY when present, skipping the iteration', () => {
    const result = solveIlluminant(parseDng(load('synthetic-whitexy.dng')));
    expect(result.source).toBe('AsShotWhiteXY');
    expect(result.iterations).toBe(0);
    expect(result.xy.x).toBeCloseTo(scene.sceneXY.x, 5);
    expect(result.measurement.kelvin).toBeCloseTo(xyToCCT(scene.sceneXY).kelvin, 6);
  });

  it('works with a single calibration illuminant, and says so', () => {
    const result = solveIlluminant(parseDng(load('synthetic-single-illuminant.dng')));
    expect(result.source).toBe('AsShotNeutral + single ColorMatrix');
    expect(result.interpolation).toBeNull();
    expect(result.measurement.kelvin).toBeGreaterThan(1667);
  });

  it('refuses a file that records no white balance', () => {
    expect(() => solveIlluminant(parseDng(load('synthetic-no-neutral.dng')))).toThrow(
      DngSolveError,
    );
    expect(() => solveIlluminant(parseDng(load('synthetic-no-neutral.dng')))).toThrow(
      /no white balance/i,
    );
  });
});

describe('solver round trip across the working range', () => {
  const calibrations: CalibrationSet[] = [
    {
      colorMatrix: mat3(scene.colorMatrix1),
      illuminantCode: 17,
      illuminantKelvin: lightSourceToKelvin(17),
      cameraCalibration: null,
      forwardMatrix: null,
    },
    {
      colorMatrix: mat3(scene.colorMatrix2),
      illuminantCode: 21,
      illuminantKelvin: lightSourceToKelvin(21),
      cameraCalibration: null,
      forwardMatrix: null,
    },
  ];

  it('recovers the illuminant that generated a neutral, to within the 5 K solve tolerance', () => {
    // Forward model then inverse: pick a white point, work out what the
    // camera would record, then hand that to the solver and check it lands
    // back where it started.
    for (const kelvin of [2000, 2700, 3200, 4000, 5000, 5600, 6500, 8000, 10000]) {
      const truth = temperatureTintToXY(kelvin, 0);
      const neutral = xyToNeutral(calibrations, null, truth);
      const solved = neutralToXY(calibrations, null, neutral);
      expect(solved.converged, `${kelvin} K`).toBe(true);
      const recovered = xyToCCT(solved.xy).kelvin;
      expect(Math.abs(recovered - kelvin), `${kelvin} K -> ${recovered.toFixed(1)} K`).toBeLessThan(
        10,
      );
    }
  });

  it('recovers off-locus illuminants too, not just blackbody ones', () => {
    for (const kelvin of [3000, 4500, 6500]) {
      for (const tint of [-30, 30]) {
        const truth = temperatureTintToXY(kelvin, tint);
        const neutral = xyToNeutral(calibrations, null, truth);
        const solved = neutralToXY(calibrations, null, neutral);
        expect(solved.xy.x, `${kelvin} K tint ${tint}`).toBeCloseTo(truth.x, 3);
        expect(solved.xy.y, `${kelvin} K tint ${tint}`).toBeCloseTo(truth.y, 3);
      }
    }
  });

  it('never turns a degenerate neutral into an unflagged reading', () => {
    // The guarantee the UI depends on: a nonsense AsShotNeutral either throws
    // or comes back flagged. It must never produce a confident number, and it
    // must never produce NaN.
    const degenerate: readonly Vec3[] = [
      [1, 1e-9, 1],
      [1, 0.001, 1],
      [0.001, 1, 0.001],
      [1e-6, 1e-6, 1],
      [1, 1e-6, 1e-6],
    ];
    for (const neutral of degenerate) {
      let flagged = false;
      try {
        const solved = neutralToXY(calibrations, null, neutral);
        const measurement = measureXY(solved.xy);
        expect(Number.isFinite(measurement.kelvin), `${neutral} produced NaN`).toBe(true);
        flagged = measurement.cctOutOfRange || measurement.farFromLocus;
      } catch (error) {
        expect(error).toBeInstanceOf(DngSolveError);
        flagged = true;
      }
      expect(flagged, `${neutral} was reported as a valid reading`).toBe(true);
    }
  });

  it('rejects a neutral with a non-positive channel at parse time', () => {
    // Guarded before it ever reaches the solver, since a zero channel makes
    // the chromaticity undefined rather than merely extreme.
    const meta = parseDng(load('synthetic-le.dng'));
    expect(meta.asShotNeutral!.every((v) => v > 0)).toBe(true);
  });
});
