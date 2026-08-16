#!/usr/bin/env node
/**
 * Generates the synthetic DNG fixtures the parser tests run against.
 *
 * These are not photographs. They are hand-built TIFF containers holding a
 * plausible but entirely synthetic camera profile, which is enough to
 * exercise both byte orders, inline and external value storage, the rational
 * types, and the full illuminant solve.
 *
 * Alongside each fixture it writes a `.exiftool.json` file in the exact shape
 * `exiftool -j -n` produces. That is deliberate: to add a real camera's DNG
 * to the suite, drop the file in `test/fixtures/` next to
 *
 *     exiftool -j -n real.dng > real.exiftool.json
 *
 * and the existing test picks it up with no code changes.
 *
 * Run with: npm run fixtures
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TYPE, ascii, buildTiff, entry, quantise } from './lib/tiff-writer.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, '..', 'test', 'fixtures');

/* ---------------------------------------------------------------------- */
/* A synthetic camera                                                      */
/* ---------------------------------------------------------------------- */

/**
 * XYZ (D65) -> linear sRGB, then a crosstalk mix standing in for the broad,
 * overlapping filters of a real Bayer array. The result is a well-conditioned
 * XYZ -> sensor matrix that behaves like a camera without pretending to be
 * any particular one.
 */
const XYZ_TO_SRGB = [
  3.2409699419045213, -1.5373831775700935, -0.4986107602930033,
  -0.9692436362808798, 1.8759675015077206, 0.0415550574071756,
  0.0556300796969936, -0.2039769588889765, 1.0569715142428786,
];

const FILTER_CROSSTALK = [
  0.90, 0.08, 0.02,
  0.05, 0.90, 0.05,
  0.02, 0.10, 0.88,
];

function matMul(a, b) {
  const out = new Array(9).fill(0);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      out[r * 3 + c] =
        a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
    }
  }
  return out;
}

function matMulVec(m, v) {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ];
}

function xyToXYZ({ x, y }) {
  return [x / y, 1, (1 - x - y) / y];
}

const ILLUMINANT_A = { x: 0.44757, y: 0.40745 };
const ILLUMINANT_D55 = { x: 0.33242, y: 0.34743 };
const ILLUMINANT_D65 = { x: 0.31272, y: 0.32903 };

/**
 * Per-channel sensitivity, chosen so the sensor's response to D55 lands near
 * (0.5, 1.0, 0.7). That is what real AsShotNeutral values look like: green
 * highest, because green filters pass the most light and a Bayer array has
 * twice as many of them. Without this the fixture would still exercise the
 * maths but would not look like camera data to anyone reading it.
 */
const TARGET_D55_RESPONSE = [0.5, 1.0, 0.7];

const XYZ_TO_SENSOR = (() => {
  const unscaled = matMul(FILTER_CROSSTALK, XYZ_TO_SRGB);
  const response = matMulVec(unscaled, xyToXYZ(ILLUMINANT_D55));
  const gain = TARGET_D55_RESPONSE.map((target, i) => target / response[i]);
  return unscaled.map((v, i) => v * gain[Math.floor(i / 3)]);
})();

/**
 * A real DNG's two colour matrices differ because the linear fit from XYZ to
 * camera is optimised separately at each calibration illuminant. That is
 * modelled here as a small distinct perturbation of the sensor matrix, which
 * keeps the overall scale physical while making the two matrices genuinely
 * different — so the mired-space interpolation in the solver is actually
 * being exercised rather than blending two identical matrices.
 */
const PERTURBATION_A = [
  1.02, -0.01, -0.01,
  0.005, 0.99, 0.005,
  -0.005, 0.01, 1.03,
];

const PERTURBATION_D65 = [
  0.98, 0.015, 0.005,
  -0.005, 1.01, -0.005,
  0.005, -0.02, 0.97,
];

const COLOR_MATRIX_1 = matMul(PERTURBATION_A, XYZ_TO_SENSOR).map(quantise);
const COLOR_MATRIX_2 = matMul(PERTURBATION_D65, XYZ_TO_SENSOR).map(quantise);

/**
 * AsShotNeutral the synthetic camera would record under a target illuminant,
 * using the same mired-space interpolation the solver uses. Written to the
 * fixture so the round trip through the solver is a genuine test.
 */
function neutralFor(whiteXY, kelvin) {
  const T1 = 2850;
  const T2 = 6500;
  let g;
  if (kelvin <= T1) g = 1;
  else if (kelvin >= T2) g = 0;
  else g = (1 / kelvin - 1 / T2) / (1 / T1 - 1 / T2);

  const matrix = COLOR_MATRIX_1.map((v, i) => v * g + COLOR_MATRIX_2[i] * (1 - g));
  const camera = matMulVec(matrix, xyToXYZ(whiteXY));
  const peak = Math.max(...camera);
  return camera.map((v) => quantise(v / peak));
}

/* ---------------------------------------------------------------------- */
/* Fixtures                                                                */
/* ---------------------------------------------------------------------- */

const TAG = {
  NewSubfileType: 254,
  ImageWidth: 256,
  ImageLength: 257,
  Make: 271,
  Model: 272,
  DNGVersion: 50706,
  DNGBackwardVersion: 50707,
  UniqueCameraModel: 50708,
  ColorMatrix1: 50721,
  ColorMatrix2: 50722,
  CameraCalibration1: 50723,
  CameraCalibration2: 50724,
  AnalogBalance: 50727,
  AsShotNeutral: 50728,
  AsShotWhiteXY: 50729,
  CalibrationIlluminant1: 50778,
  CalibrationIlluminant2: 50779,
  ProfileName: 50936,
};

/** The illuminant each fixture was "shot" under. */
const SCENE_XY = { x: 0.4091, y: 0.3906 }; // roughly a 3200 K tungsten balance
const SCENE_KELVIN = 3200;
const AS_SHOT_NEUTRAL = neutralFor(SCENE_XY, SCENE_KELVIN);

/**
 * Two more scenes at the ends of the working range. Having fixtures that
 * genuinely differ in temperature is what lets a two-point calibration be
 * exercised against real file bytes rather than against one value repeated.
 */
const WARM_SCENE_XY = { x: 0.4599, y: 0.4106 }; // ~2700 K
const WARM_SCENE_KELVIN = 2700;
const COOL_SCENE_XY = { x: 0.3221, y: 0.3318 }; // ~6000 K
const COOL_SCENE_KELVIN = 6000;

function baseEntries() {
  return [
    entry(TAG.NewSubfileType, TYPE.LONG, [0]),
    entry(TAG.ImageWidth, TYPE.LONG, [4032]),
    entry(TAG.ImageLength, TYPE.LONG, [3024]),
    ascii(TAG.Make, 'KelvinMeter'),
    ascii(TAG.Model, 'Synthetic Reference Camera'),
    entry(TAG.DNGVersion, TYPE.BYTE, [1, 4, 0, 0]),
    entry(TAG.DNGBackwardVersion, TYPE.BYTE, [1, 1, 0, 0]),
    ascii(TAG.UniqueCameraModel, 'KelvinMeter Synthetic Reference Camera'),
    entry(TAG.ColorMatrix1, TYPE.SRATIONAL, COLOR_MATRIX_1),
    entry(TAG.ColorMatrix2, TYPE.SRATIONAL, COLOR_MATRIX_2),
    entry(TAG.CameraCalibration1, TYPE.SRATIONAL, [1, 0, 0, 0, 1, 0, 0, 0, 1]),
    entry(TAG.CameraCalibration2, TYPE.SRATIONAL, [1, 0, 0, 0, 1, 0, 0, 0, 1]),
    entry(TAG.AnalogBalance, TYPE.RATIONAL, [1, 1, 1]),
    entry(TAG.AsShotNeutral, TYPE.RATIONAL, AS_SHOT_NEUTRAL),
    entry(TAG.CalibrationIlluminant1, TYPE.SHORT, [17]), // Standard light A
    entry(TAG.CalibrationIlluminant2, TYPE.SHORT, [21]), // D65
    ascii(TAG.ProfileName, 'KelvinMeter Synthetic'),
  ];
}

/** exiftool -j -n renders numeric arrays as space-joined strings. */
function exifList(values) {
  return values.map((v) => String(v)).join(' ');
}

function exiftoolJson(sourceFile, extra = {}) {
  return [
    {
      SourceFile: sourceFile,
      Make: 'KelvinMeter',
      Model: 'Synthetic Reference Camera',
      UniqueCameraModel: 'KelvinMeter Synthetic Reference Camera',
      DNGVersion: '1 4 0 0',
      DNGBackwardVersion: '1 1 0 0',
      ProfileName: 'KelvinMeter Synthetic',
      ImageWidth: 4032,
      ImageHeight: 3024,
      ColorMatrix1: exifList(COLOR_MATRIX_1),
      ColorMatrix2: exifList(COLOR_MATRIX_2),
      CameraCalibration1: '1 0 0 0 1 0 0 0 1',
      CameraCalibration2: '1 0 0 0 1 0 0 0 1',
      AnalogBalance: '1 1 1',
      AsShotNeutral: exifList(AS_SHOT_NEUTRAL),
      CalibrationIlluminant1: 17,
      CalibrationIlluminant2: 21,
      ...extra,
    },
  ];
}

function write(name, bytes) {
  writeFileSync(join(fixturesDir, name), bytes);
  console.log(`  ${name}  ${bytes.length} bytes`);
}

function writeJson(name, value) {
  writeFileSync(join(fixturesDir, name), `${JSON.stringify(value, null, 2)}\n`);
  console.log(`  ${name}`);
}

mkdirSync(fixturesDir, { recursive: true });
console.log('Writing DNG fixtures:');

// 1. Little-endian, the common case.
write('synthetic-le.dng', buildTiff(baseEntries(), { littleEndian: true }));
writeJson('synthetic-le.exiftool.json', exiftoolJson('synthetic-le.dng'));

// 2. Big-endian, byte-for-byte the same metadata.
write('synthetic-be.dng', buildTiff(baseEntries(), { littleEndian: false }));
writeJson('synthetic-be.exiftool.json', exiftoolJson('synthetic-be.dng'));

// 3. A writer that stored the chromaticity directly, which short-circuits
//    the whole iterative solve.
const withWhiteXY = [
  ...baseEntries(),
  entry(TAG.AsShotWhiteXY, TYPE.RATIONAL, [quantise(SCENE_XY.x), quantise(SCENE_XY.y)]),
];
write('synthetic-whitexy.dng', buildTiff(withWhiteXY, { littleEndian: true }));
writeJson(
  'synthetic-whitexy.exiftool.json',
  exiftoolJson('synthetic-whitexy.dng', {
    AsShotWhiteXY: `${quantise(SCENE_XY.x)} ${quantise(SCENE_XY.y)}`,
  }),
);

// 4. The same camera under a warm and a cool source, so a two-point
//    calibration has two genuinely different measurements to fit.
for (const [name, xy, kelvin] of [
  ['synthetic-warm.dng', WARM_SCENE_XY, WARM_SCENE_KELVIN],
  ['synthetic-cool.dng', COOL_SCENE_XY, COOL_SCENE_KELVIN],
]) {
  const neutral = neutralFor(xy, kelvin);
  const entries = baseEntries()
    .filter((item) => item.tag !== TAG.AsShotNeutral)
    .concat(entry(TAG.AsShotNeutral, TYPE.RATIONAL, neutral));
  write(name, buildTiff(entries, { littleEndian: true }));
  writeJson(
    `${name.replace(/\.dng$/, '')}.exiftool.json`,
    exiftoolJson(name, { AsShotNeutral: exifList(neutral) }),
  );
}

// 5. A DNG with only one calibration illuminant, so nothing can be
//    interpolated.
const singleIlluminant = baseEntries().filter(
  (item) =>
    item.tag !== TAG.ColorMatrix2 &&
    item.tag !== TAG.CameraCalibration2 &&
    item.tag !== TAG.CalibrationIlluminant2,
);
write('synthetic-single-illuminant.dng', buildTiff(singleIlluminant, { littleEndian: true }));

// 6. A file with no white balance recorded at all.
const noWhiteBalance = baseEntries().filter((item) => item.tag !== TAG.AsShotNeutral);
write('synthetic-no-neutral.dng', buildTiff(noWhiteBalance, { littleEndian: true }));

// 7. Truncated mid-IFD, to check the parser fails cleanly instead of
//    reading past the end of the buffer.
const complete = buildTiff(baseEntries(), { littleEndian: true });
write('synthetic-truncated.dng', complete.slice(0, 40));

// 8. Not a TIFF at all.
write('not-a-dng.bin', new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]));

// The scene the fixtures encode, so tests can assert the solve recovers it.
writeJson('synthetic-scene.json', {
  note: 'Ground truth for the synthetic fixtures. Regenerate with: npm run fixtures',
  sceneXY: { x: quantise(SCENE_XY.x), y: quantise(SCENE_XY.y) },
  sceneKelvinUsedForInterpolation: SCENE_KELVIN,
  warmSceneXY: { x: quantise(WARM_SCENE_XY.x), y: quantise(WARM_SCENE_XY.y) },
  coolSceneXY: { x: quantise(COOL_SCENE_XY.x), y: quantise(COOL_SCENE_XY.y) },
  asShotNeutral: AS_SHOT_NEUTRAL,
  colorMatrix1: COLOR_MATRIX_1,
  colorMatrix2: COLOR_MATRIX_2,
  calibrationIlluminant1Kelvin: 2850,
  calibrationIlluminant2Kelvin: 6500,
});

console.log('Done.');
