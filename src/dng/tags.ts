/**
 * The TIFF/DNG tag subset this app needs.
 *
 * DNG is a TIFF 6.0 extension, so the container is an ordinary IFD chain.
 * Only white-balance-relevant tags are listed; the pixel data is untouched.
 */

export const TIFF_TAG = {
  NewSubfileType: 254,
  ImageWidth: 256,
  ImageLength: 257,
  Make: 271,
  Model: 272,
  SubIFDs: 330,
  DateTimeOriginal: 36867,
  ExifIFD: 34665,
  DNGVersion: 50706,
  DNGBackwardVersion: 50707,
  UniqueCameraModel: 50708,
  ColorMatrix1: 50721,
  ColorMatrix2: 50722,
  CameraCalibration1: 50723,
  CameraCalibration2: 50724,
  ReductionMatrix1: 50725,
  ReductionMatrix2: 50726,
  AnalogBalance: 50727,
  AsShotNeutral: 50728,
  AsShotWhiteXY: 50729,
  BaselineExposure: 50730,
  CalibrationIlluminant1: 50778,
  CalibrationIlluminant2: 50779,
  ProfileName: 50936,
  ForwardMatrix1: 50964,
  ForwardMatrix2: 50965,
  /** DNG 1.6 added a third calibration illuminant. */
  ColorMatrix3: 51041,
  CameraCalibration3: 51042,
  ReductionMatrix3: 51043,
  ProfileHueSatMapData3: 51044,
  CalibrationIlluminant3: 51045,
} as const;

/** EXIF IFD tags worth surfacing so a reading can be traced to a shot. */
export const EXIF_TAG = {
  ExposureTime: 33434,
  FNumber: 33437,
  ISOSpeedRatings: 34855,
  DateTimeOriginal: 36867,
  LensModel: 42036,
} as const;

export const TIFF_TYPE = {
  BYTE: 1,
  ASCII: 2,
  SHORT: 3,
  LONG: 4,
  RATIONAL: 5,
  SBYTE: 6,
  UNDEFINED: 7,
  SSHORT: 8,
  SLONG: 9,
  SRATIONAL: 10,
  FLOAT: 11,
  DOUBLE: 12,
  LONG8: 16,
  SLONG8: 17,
  IFD8: 18,
} as const;

export const TIFF_TYPE_SIZE: Readonly<Record<number, number>> = {
  [TIFF_TYPE.BYTE]: 1,
  [TIFF_TYPE.ASCII]: 1,
  [TIFF_TYPE.SHORT]: 2,
  [TIFF_TYPE.LONG]: 4,
  [TIFF_TYPE.RATIONAL]: 8,
  [TIFF_TYPE.SBYTE]: 1,
  [TIFF_TYPE.UNDEFINED]: 1,
  [TIFF_TYPE.SSHORT]: 2,
  [TIFF_TYPE.SLONG]: 4,
  [TIFF_TYPE.SRATIONAL]: 8,
  [TIFF_TYPE.FLOAT]: 4,
  [TIFF_TYPE.DOUBLE]: 8,
  [TIFF_TYPE.LONG8]: 8,
  [TIFF_TYPE.SLONG8]: 8,
  [TIFF_TYPE.IFD8]: 8,
};

