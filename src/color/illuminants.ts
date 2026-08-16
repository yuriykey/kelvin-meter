/**
 * Standard illuminants, and the EXIF LightSource codes DNG uses to name them.
 */

import type { XY } from './chromaticity.ts';

export const ILLUMINANT_A: XY = { x: 0.44757, y: 0.40745 };
export const ILLUMINANT_D50: XY = { x: 0.34567, y: 0.3585 };
export const ILLUMINANT_D55: XY = { x: 0.33242, y: 0.34743 };
export const ILLUMINANT_D65: XY = { x: 0.31272, y: 0.32903 };
export const ILLUMINANT_D75: XY = { x: 0.29902, y: 0.31485 };

/** EXIF LightSource tag values (EXIF 2.3 table 4, extended by the DNG spec). */
export enum LightSource {
  Unknown = 0,
  Daylight = 1,
  Fluorescent = 2,
  Tungsten = 3,
  Flash = 4,
  FineWeather = 9,
  CloudyWeather = 10,
  Shade = 11,
  DaylightFluorescent = 12,
  DayWhiteFluorescent = 13,
  CoolWhiteFluorescent = 14,
  WhiteFluorescent = 15,
  WarmWhiteFluorescent = 16,
  StandardLightA = 17,
  StandardLightB = 18,
  StandardLightC = 19,
  D55 = 20,
  D65 = 21,
  D75 = 22,
  D50 = 23,
  ISOStudioTungsten = 24,
  Other = 255,
}

/**
 * Nominal CCT for an EXIF LightSource code.
 *
 * These are Adobe's values from `dng_camera_profile::IlluminantToTemperature`,
 * not the textbook chromaticity temperatures. That matters: the numbers are
 * only ever used as interpolation endpoints between ColorMatrix1 and
 * ColorMatrix2, and a profile authored by Adobe was fitted assuming these
 * exact endpoints. Substituting the "more correct" 2856 K for Standard
 * Light A would shift every interpolated matrix away from what the profile
 * author intended.
 */
export function lightSourceToKelvin(code: number): number {
  switch (code) {
    case LightSource.StandardLightA:
    case LightSource.Tungsten:
      return 2850;
    case LightSource.ISOStudioTungsten:
      return 3200;
    case LightSource.D50:
      return 5000;
    case LightSource.D55:
    case LightSource.Daylight:
    case LightSource.FineWeather:
    case LightSource.Flash:
    case LightSource.StandardLightB:
      return 5500;
    case LightSource.D65:
    case LightSource.StandardLightC:
    case LightSource.CloudyWeather:
      return 6500;
    case LightSource.D75:
    case LightSource.Shade:
      return 7500;
    case LightSource.DaylightFluorescent:
      return (5700 + 7100) * 0.5;
    case LightSource.DayWhiteFluorescent:
      return (4600 + 5500) * 0.5;
    case LightSource.CoolWhiteFluorescent:
    case LightSource.Fluorescent:
      return (3800 + 4500) * 0.5;
    case LightSource.WhiteFluorescent:
      return (3250 + 3800) * 0.5;
    case LightSource.WarmWhiteFluorescent:
      return (2600 + 3250) * 0.5;
    default:
      return 5000;
  }
}

export function lightSourceName(code: number): string {
  switch (code) {
    case LightSource.Unknown: return 'Unknown';
    case LightSource.Daylight: return 'Daylight';
    case LightSource.Fluorescent: return 'Fluorescent';
    case LightSource.Tungsten: return 'Tungsten';
    case LightSource.Flash: return 'Flash';
    case LightSource.FineWeather: return 'Fine weather';
    case LightSource.CloudyWeather: return 'Cloudy';
    case LightSource.Shade: return 'Shade';
    case LightSource.DaylightFluorescent: return 'Daylight fluorescent';
    case LightSource.DayWhiteFluorescent: return 'Day white fluorescent';
    case LightSource.CoolWhiteFluorescent: return 'Cool white fluorescent';
    case LightSource.WhiteFluorescent: return 'White fluorescent';
    case LightSource.WarmWhiteFluorescent: return 'Warm white fluorescent';
    case LightSource.StandardLightA: return 'Standard light A';
    case LightSource.StandardLightB: return 'Standard light B';
    case LightSource.StandardLightC: return 'Standard light C';
    case LightSource.D55: return 'D55';
    case LightSource.D65: return 'D65';
    case LightSource.D75: return 'D75';
    case LightSource.D50: return 'D50';
    case LightSource.ISOStudioTungsten: return 'ISO studio tungsten';
    case LightSource.Other: return 'Other';
    default: return `Code ${code}`;
  }
}

/**
 * Reference sources a user can realistically calibrate against, with an
 * honest note on how much each one can be trusted.
 */
export interface ReferenceSource {
  readonly id: string;
  readonly label: string;
  readonly kelvin: number;
  readonly tolerance: string;
  readonly trust: 'good' | 'rough';
}

export const REFERENCE_SOURCES: readonly ReferenceSource[] = [
  { id: 'led-3200', label: 'Bi-colour LED panel, 3200 K preset', kelvin: 3200, tolerance: '±100 K', trust: 'good' },
  { id: 'led-4300', label: 'Bi-colour LED panel, 4300 K preset', kelvin: 4300, tolerance: '±100 K', trust: 'good' },
  { id: 'led-5600', label: 'Bi-colour LED panel, 5600 K preset', kelvin: 5600, tolerance: '±100 K', trust: 'good' },
  { id: 'd50-booth', label: 'D50 viewing booth', kelvin: 5003, tolerance: '±50 K', trust: 'good' },
  { id: 'd65-booth', label: 'D65 viewing booth', kelvin: 6504, tolerance: '±50 K', trust: 'good' },
  { id: 'bulb-2700', label: 'Household bulb marked 2700 K', kelvin: 2700, tolerance: '±150 K', trust: 'rough' },
  { id: 'bulb-3000', label: 'Household bulb marked 3000 K', kelvin: 3000, tolerance: '±150 K', trust: 'rough' },
  { id: 'bulb-4000', label: 'Household bulb marked 4000 K', kelvin: 4000, tolerance: '±150 K', trust: 'rough' },
  { id: 'bulb-5000', label: 'Household bulb marked 5000 K', kelvin: 5000, tolerance: '±150 K', trust: 'rough' },
  { id: 'overcast', label: 'Overcast north sky', kelvin: 6500, tolerance: '±700 K', trust: 'rough' },
];
