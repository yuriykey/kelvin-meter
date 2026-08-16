/**
 * Pulls the white-balance-relevant metadata out of a DNG.
 *
 * The camera's own illuminant estimate lives here, in unprocessed camera
 * space, which is the whole reason this mode exists: `getUserMedia` hands
 * back frames the camera has already white-balanced, and that processing has
 * removed the colour cast we are trying to measure.
 */

import { type Mat3, type Vec3, lightSourceToKelvin, mat3, vec3 } from '../color/index.ts';
import { EXIF_TAG, TIFF_TAG } from './tags.ts';
import { TiffParseError, TiffReader, type Ifd, type TiffEntry } from './tiff.ts';

export interface CalibrationSet {
  /** XYZ -> camera, for a scene lit by `illuminantCode`. */
  readonly colorMatrix: Mat3;
  /** EXIF LightSource code this matrix was calibrated under. */
  readonly illuminantCode: number;
  readonly illuminantKelvin: number;
  readonly cameraCalibration: Mat3 | null;
  /**
   * Parsed for the audit readout only. ForwardMatrix describes rendering to
   * a fixed white point and plays no part in recovering the illuminant.
   */
  readonly forwardMatrix: Mat3 | null;
}

export interface DngMetadata {
  readonly make: string | null;
  readonly model: string | null;
  readonly uniqueCameraModel: string | null;
  readonly profileName: string | null;
  readonly dngVersion: string | null;
  readonly dateTimeOriginal: string | null;
  readonly isoSpeed: number | null;

  /** Camera-native RGB of the scene neutral. The core measurement. */
  readonly asShotNeutral: Vec3 | null;
  /** Some writers store the illuminant chromaticity directly. */
  readonly asShotWhiteXY: { readonly x: number; readonly y: number } | null;
  readonly analogBalance: Vec3 | null;
  /** Sorted by calibration temperature, coolest first. */
  readonly calibrations: readonly CalibrationSet[];

  /** Every known tag actually found, for the auditable readout in the UI. */
  readonly tagsPresent: readonly string[];
  readonly byteOrder: 'little-endian' | 'big-endian';
  readonly bigTiff: boolean;
  readonly ifdCount: number;
}

export class DngParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DngParseError';
  }
}

/** Look a tag up across all IFDs, in the order they were discovered. */
function findEntry(ifds: readonly Ifd[], tag: number): TiffEntry | null {
  for (const ifd of ifds) {
    const entry = ifd.entries.get(tag);
    if (entry) return entry;
  }
  return null;
}

function readNumbers(
  reader: TiffReader,
  ifds: readonly Ifd[],
  tag: number,
  expectedCount?: number,
): number[] | null {
  const entry = findEntry(ifds, tag);
  if (!entry) return null;
  if (expectedCount !== undefined && entry.count !== expectedCount) return null;
  try {
    return reader.getNumbers(entry);
  } catch {
    return null;
  }
}

function readString(reader: TiffReader, ifds: readonly Ifd[], tag: number): string | null {
  const entry = findEntry(ifds, tag);
  if (!entry) return null;
  try {
    const text = reader.getString(entry);
    return text.length > 0 ? text : null;
  } catch {
    return null;
  }
}

function readMatrix(reader: TiffReader, ifds: readonly Ifd[], tag: number): Mat3 | null {
  const values = readNumbers(reader, ifds, tag, 9);
  if (!values || values.some((v) => !Number.isFinite(v))) return null;
  return mat3(values);
}

/**
 * The three calibration slots DNG defines. Slot 3 arrived in DNG 1.6 and has
 * no ForwardMatrix counterpart in the tag range this parser recognises, so it
 * is read for the colour matrix only.
 */
const CALIBRATION_SLOTS = [
  {
    color: TIFF_TAG.ColorMatrix1,
    cameraCalibration: TIFF_TAG.CameraCalibration1,
    forward: TIFF_TAG.ForwardMatrix1,
    illuminant: TIFF_TAG.CalibrationIlluminant1,
  },
  {
    color: TIFF_TAG.ColorMatrix2,
    cameraCalibration: TIFF_TAG.CameraCalibration2,
    forward: TIFF_TAG.ForwardMatrix2,
    illuminant: TIFF_TAG.CalibrationIlluminant2,
  },
  {
    color: TIFF_TAG.ColorMatrix3,
    cameraCalibration: TIFF_TAG.CameraCalibration3,
    forward: null,
    illuminant: TIFF_TAG.CalibrationIlluminant3,
  },
] as const;

export function parseDng(buffer: ArrayBuffer): DngMetadata {
  let reader: TiffReader;
  try {
    reader = new TiffReader(buffer);
  } catch (error) {
    throw new DngParseError(
      error instanceof TiffParseError
        ? error.message
        : 'File could not be read as a TIFF/DNG',
    );
  }

  let ifds: Ifd[];
  try {
    ifds = reader.readAllIfds();
  } catch (error) {
    throw new DngParseError(
      error instanceof TiffParseError ? error.message : 'File contains no readable IFD',
    );
  }

  const calibrations: CalibrationSet[] = [];
  for (const slot of CALIBRATION_SLOTS) {
    const colorMatrix = readMatrix(reader, ifds, slot.color);
    if (!colorMatrix) continue;
    const illuminantCode = readNumbers(reader, ifds, slot.illuminant, 1)?.[0] ?? 0;
    calibrations.push({
      colorMatrix,
      illuminantCode,
      illuminantKelvin: lightSourceToKelvin(illuminantCode),
      cameraCalibration: readMatrix(reader, ifds, slot.cameraCalibration),
      forwardMatrix: slot.forward === null ? null : readMatrix(reader, ifds, slot.forward),
    });
  }
  // The solver interpolates between the two calibrations that bracket the
  // current estimate, so keeping them ordered by temperature makes that
  // search trivial and removes any dependence on tag ordering in the file.
  calibrations.sort((a, b) => a.illuminantKelvin - b.illuminantKelvin);

  const asShotNeutralValues = readNumbers(reader, ifds, TIFF_TAG.AsShotNeutral, 3);
  const asShotWhiteValues = readNumbers(reader, ifds, TIFF_TAG.AsShotWhiteXY, 2);
  const analogBalanceValues = readNumbers(reader, ifds, TIFF_TAG.AnalogBalance, 3);
  const dngVersionBytes = readNumbers(reader, ifds, TIFF_TAG.DNGVersion, 4);

  const tagsPresent: string[] = [];
  for (const [name, tag] of Object.entries(TIFF_TAG)) {
    if (findEntry(ifds, tag)) tagsPresent.push(name);
  }

  return {
    make: readString(reader, ifds, TIFF_TAG.Make),
    model: readString(reader, ifds, TIFF_TAG.Model),
    uniqueCameraModel: readString(reader, ifds, TIFF_TAG.UniqueCameraModel),
    profileName: readString(reader, ifds, TIFF_TAG.ProfileName),
    dngVersion: dngVersionBytes ? dngVersionBytes.join('.') : null,
    dateTimeOriginal: readString(reader, ifds, TIFF_TAG.DateTimeOriginal),
    isoSpeed: readNumbers(reader, ifds, EXIF_TAG.ISOSpeedRatings)?.[0] ?? null,
    asShotNeutral: asShotNeutralValues ? sanitiseNeutral(asShotNeutralValues) : null,
    asShotWhiteXY: sanitiseWhiteXY(asShotWhiteValues),
    analogBalance:
      analogBalanceValues && analogBalanceValues.every((v) => Number.isFinite(v) && v > 0)
        ? vec3(analogBalanceValues)
        : null,
    calibrations,
    tagsPresent,
    byteOrder: reader.littleEndian ? 'little-endian' : 'big-endian',
    bigTiff: reader.bigTiff,
    ifdCount: ifds.length,
  };
}

/**
 * AsShotNeutral only carries meaning as a ratio, and a zero or negative
 * channel makes the illuminant solve singular, so reject those outright
 * rather than producing a confident wrong answer.
 */
function sanitiseNeutral(values: readonly number[]): Vec3 | null {
  if (values.length !== 3) return null;
  if (!values.every((v) => Number.isFinite(v) && v > 1e-6)) return null;
  return vec3(values);
}

function sanitiseWhiteXY(
  values: readonly number[] | null,
): { readonly x: number; readonly y: number } | null {
  if (!values || values.length !== 2) return null;
  const [x, y] = values as [number, number];
  // A chromaticity outside the spectral horseshoe's bounding box is corrupt.
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  if (x <= 0 || y <= 0 || x >= 1 || y >= 1 || x + y >= 1) return null;
  return { x, y };
}
