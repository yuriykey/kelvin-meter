/**
 * Recovers the scene illuminant's chromaticity from a DNG's AsShotNeutral.
 *
 * The problem is circular by construction: to build the XYZ->camera matrix
 * you have to interpolate between the two calibration illuminants, and to
 * pick the interpolation weight you need the colour temperature, which is
 * what you are trying to find. The DNG spec resolves it by fixed-point
 * iteration, seeded at D50, and it converges in about three passes because
 * the matrix varies slowly with temperature.
 *
 * Interpolation happens in mired (reciprocal) space, not Kelvin. That is not
 * cosmetic: between a 2850 K and a 6500 K calibration, linear-in-Kelvin
 * weighting puts the halfway matrix at 4675 K where perceptually it belongs
 * at 3970 K, and every intermediate reading inherits that bias.
 */

import {
  type Mat3,
  type Vec3,
  type XY,
  invert,
  matAddScaled,
  matMul,
  matMulVec,
  diagonal,
  lightSourceName,
  xyToTemperatureTint,
  xyzToXY,
  measureXY,
  type Measurement,
  type TemperatureTint,
} from '../color/index.ts';
import type { CalibrationSet, DngMetadata } from './parse.ts';

/** The DNG spec's own seed for the iteration. */
export const SOLVE_SEED_XY: XY = { x: 0.34567, y: 0.3585 };
/** Stop once the estimate stops moving by more than this many Kelvin. */
export const SOLVE_TOLERANCE_KELVIN = 5;
export const SOLVE_MAX_ITERATIONS = 30;

export type IlluminantSource =
  | 'AsShotWhiteXY'
  | 'AsShotNeutral + ColorMatrix interpolation'
  | 'AsShotNeutral + single ColorMatrix';

/**
 * How the two calibration matrices were blended, for the audit readout.
 *
 * `warmWeight` is the fraction taken from the lower-temperature calibration.
 * Low colour temperature means warm light, so naming it by temperature alone
 * inverts in conversation — hence both the weight and the illuminant names.
 */
export interface InterpolationDetail {
  readonly warmWeight: number;
  readonly warmKelvin: number;
  readonly coolKelvin: number;
  readonly warmName: string;
  readonly coolName: string;
}

export interface SolveResult {
  readonly xy: XY;
  readonly measurement: Measurement;
  readonly adobe: TemperatureTint;
  /** Which tag the reading came from, so the number is auditable. */
  readonly source: IlluminantSource;
  readonly iterations: number;
  readonly converged: boolean;
  /** Null when the file has only one calibration illuminant. */
  readonly interpolation: InterpolationDetail | null;
}

export class DngSolveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DngSolveError';
  }
}

/**
 * XYZ -> camera for a given white point, per the DNG spec:
 *
 *     XYZtoCamera = AnalogBalance . CameraCalibration . ColorMatrix
 *
 * with ColorMatrix and CameraCalibration interpolated between the bracketing
 * calibration illuminants by reciprocal temperature.
 */
export function findXYZtoCamera(
  calibrations: readonly CalibrationSet[],
  analogBalance: Vec3 | null,
  white: XY,
): { matrix: Mat3; interpolation: InterpolationDetail | null } {
  if (calibrations.length === 0) {
    throw new DngSolveError('File has no ColorMatrix tag, so it cannot be solved');
  }

  const { colorMatrix, cameraCalibration, interpolation } = interpolateCalibration(
    calibrations,
    white,
  );

  let matrix = colorMatrix;
  if (cameraCalibration) matrix = matMul(cameraCalibration, matrix);
  if (analogBalance) matrix = matMul(diagonal(analogBalance), matrix);
  return { matrix, interpolation };
}

function interpolateCalibration(
  calibrations: readonly CalibrationSet[],
  white: XY,
): { colorMatrix: Mat3; cameraCalibration: Mat3 | null; interpolation: InterpolationDetail | null } {
  const first = calibrations[0]!;
  if (calibrations.length === 1) {
    return {
      colorMatrix: first.colorMatrix,
      cameraCalibration: first.cameraCalibration,
      interpolation: null,
    };
  }

  // Adobe's own temperature scale is used to choose the weight, because the
  // profile was authored against that scale.
  const kelvin = xyToTemperatureTint(white).kelvin;

  // `calibrations` is sorted coolest-first, so find the bracketing pair.
  let lower = first;
  let upper = calibrations[calibrations.length - 1]!;
  for (let i = 0; i < calibrations.length - 1; i++) {
    const a = calibrations[i]!;
    const b = calibrations[i + 1]!;
    if (kelvin <= b.illuminantKelvin) {
      lower = a;
      upper = b;
      break;
    }
    lower = a;
    upper = b;
  }

  if (lower.illuminantKelvin === upper.illuminantKelvin) {
    return {
      colorMatrix: lower.colorMatrix,
      cameraCalibration: lower.cameraCalibration,
      interpolation: describeInterpolation(lower, upper, 1),
    };
  }

  // Fraction of the cooler calibration, computed in mired space.
  let g: number;
  if (kelvin <= lower.illuminantKelvin) g = 1;
  else if (kelvin >= upper.illuminantKelvin) g = 0;
  else {
    const invT = 1 / kelvin;
    g = (invT - 1 / upper.illuminantKelvin) /
      (1 / lower.illuminantKelvin - 1 / upper.illuminantKelvin);
  }

  const colorMatrix =
    g >= 1
      ? lower.colorMatrix
      : g <= 0
        ? upper.colorMatrix
        : matAddScaled(lower.colorMatrix, g, upper.colorMatrix, 1 - g);

  let cameraCalibration: Mat3 | null = null;
  if (lower.cameraCalibration && upper.cameraCalibration) {
    cameraCalibration =
      g >= 1
        ? lower.cameraCalibration
        : g <= 0
          ? upper.cameraCalibration
          : matAddScaled(lower.cameraCalibration, g, upper.cameraCalibration, 1 - g);
  } else {
    cameraCalibration = lower.cameraCalibration ?? upper.cameraCalibration;
  }

  return {
    colorMatrix,
    cameraCalibration,
    interpolation: describeInterpolation(lower, upper, g),
  };
}

function describeInterpolation(
  warm: CalibrationSet,
  cool: CalibrationSet,
  warmWeight: number,
): InterpolationDetail {
  return {
    warmWeight,
    warmKelvin: warm.illuminantKelvin,
    coolKelvin: cool.illuminantKelvin,
    warmName: lightSourceName(warm.illuminantCode),
    coolName: lightSourceName(cool.illuminantCode),
  };
}

/**
 * Fixed-point solve for the illuminant chromaticity.
 *
 * Converges when the CCT implied by successive estimates moves by less than
 * `SOLVE_TOLERANCE_KELVIN`. If it is still oscillating at the iteration cap
 * the last two estimates are averaged, which is what the DNG SDK does and
 * what stops a limit cycle from being reported as a reading.
 */
export function neutralToXY(
  calibrations: readonly CalibrationSet[],
  analogBalance: Vec3 | null,
  neutral: Vec3,
): {
  xy: XY;
  iterations: number;
  converged: boolean;
  interpolation: InterpolationDetail | null;
} {
  let current: XY = SOLVE_SEED_XY;
  let previousKelvin = Number.NaN;
  let interpolation: InterpolationDetail | null = null;

  for (let iteration = 1; iteration <= SOLVE_MAX_ITERATIONS; iteration++) {
    const found = findXYZtoCamera(calibrations, analogBalance, current);
    const matrix = found.matrix;
    interpolation = found.interpolation;

    let xyz: Vec3;
    try {
      xyz = matMulVec(invert(matrix), neutral);
    } catch {
      throw new DngSolveError(
        'The camera colour matrix in this file cannot be inverted, so the illuminant cannot be recovered',
      );
    }

    if (!(xyz[0] + xyz[1] + xyz[2] > 0) || xyz[1] <= 0) {
      throw new DngSolveError(
        'AsShotNeutral and the colour matrix imply a physically impossible colour',
      );
    }

    const next = xyzToXY(xyz);
    const kelvin = xyToTemperatureTint(next).kelvin;

    if (Number.isFinite(previousKelvin) && Math.abs(kelvin - previousKelvin) < SOLVE_TOLERANCE_KELVIN) {
      return { xy: next, iterations: iteration, converged: true, interpolation };
    }

    if (iteration === SOLVE_MAX_ITERATIONS) {
      // Almost certainly a two-value limit cycle; split the difference.
      const averaged: XY = { x: (current.x + next.x) / 2, y: (current.y + next.y) / 2 };
      return { xy: averaged, iterations: iteration, converged: false, interpolation };
    }

    previousKelvin = kelvin;
    current = next;
  }

  /* istanbul ignore next -- the loop always returns */
  throw new DngSolveError('Illuminant solve did not terminate');
}

/** End-to-end: parsed DNG metadata in, measurement out. */
export function solveIlluminant(metadata: DngMetadata): SolveResult {
  // A writer that stored the chromaticity directly has already done this
  // work, and its answer is authoritative over anything we re-derive.
  if (metadata.asShotWhiteXY) {
    const xy = metadata.asShotWhiteXY;
    return {
      xy,
      measurement: measureXY(xy),
      adobe: xyToTemperatureTint(xy),
      source: 'AsShotWhiteXY',
      iterations: 0,
      converged: true,
      interpolation: null,
    };
  }

  if (!metadata.asShotNeutral) {
    throw new DngSolveError(
      'File has neither AsShotWhiteXY nor AsShotNeutral, so it records no white balance',
    );
  }
  if (metadata.calibrations.length === 0) {
    throw new DngSolveError(
      'File has AsShotNeutral but no ColorMatrix, so camera RGB cannot be mapped to XYZ',
    );
  }

  const solved = neutralToXY(
    metadata.calibrations,
    metadata.analogBalance,
    metadata.asShotNeutral,
  );

  return {
    xy: solved.xy,
    measurement: measureXY(solved.xy),
    adobe: xyToTemperatureTint(solved.xy),
    source:
      metadata.calibrations.length > 1
        ? 'AsShotNeutral + ColorMatrix interpolation'
        : 'AsShotNeutral + single ColorMatrix',
    iterations: solved.iterations,
    converged: solved.converged,
    interpolation: solved.interpolation,
  };
}

/**
 * The forward direction: what AsShotNeutral a camera with these calibrations
 * would record under a known illuminant. Only used by tests, where it makes
 * the solver checkable without needing a reference DNG for every camera.
 */
export function xyToNeutral(
  calibrations: readonly CalibrationSet[],
  analogBalance: Vec3 | null,
  white: XY,
): Vec3 {
  const { matrix } = findXYZtoCamera(calibrations, analogBalance, white);
  const xyz: Vec3 = [white.x / white.y, 1, (1 - white.x - white.y) / white.y];
  const camera = matMulVec(matrix, xyz);
  // DNG normalises AsShotNeutral so the largest channel is 1.
  const peak = Math.max(camera[0], camera[1], camera[2]);
  if (!(peak > 0)) throw new DngSolveError('Degenerate camera response');
  return [camera[0] / peak, camera[1] / peak, camera[2] / peak];
}
