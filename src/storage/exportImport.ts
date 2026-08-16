/**
 * JSON export and import, and CSV export of the shoot log.
 *
 * On iOS this is not a convenience feature. Safari evicts web app storage
 * from origins that have not been visited recently, and a home screen icon
 * does not protect you. A calibration set is worth more than the app, so it
 * has to be able to leave.
 */

import type { CalibrationProfile } from '../calibration/index.ts';
import type { StoredMeasurement } from './db.ts';

export const BACKUP_FORMAT = 'kelvinmeter-backup';
export const BACKUP_VERSION = 1;

export interface BackupFile {
  readonly format: typeof BACKUP_FORMAT;
  readonly version: number;
  readonly exportedAt: string;
  readonly appVersion: string;
  readonly profiles: readonly CalibrationProfile[];
  readonly measurements: readonly StoredMeasurement[];
}

export class ImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImportError';
  }
}

export function buildBackup(
  profiles: readonly CalibrationProfile[],
  measurements: readonly StoredMeasurement[],
  appVersion: string,
): BackupFile {
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    appVersion,
    profiles,
    measurements,
  };
}

export function serialiseBackup(backup: BackupFile): string {
  return JSON.stringify(backup, null, 2);
}

/**
 * Parse a backup file.
 *
 * Validation is strict about shape but forgiving about missing optional
 * fields, so a backup from an older build still restores. Anything that fails
 * validation is rejected with a message naming the problem, rather than being
 * half-imported.
 */
export function parseBackup(text: string): BackupFile {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ImportError('That file is not valid JSON.');
  }

  if (typeof raw !== 'object' || raw === null) {
    throw new ImportError('That file does not contain a KelvinMeter backup.');
  }

  const candidate = raw as Partial<BackupFile>;
  if (candidate.format !== BACKUP_FORMAT) {
    throw new ImportError(
      'That file is not a KelvinMeter backup. Pick a file exported from this app.',
    );
  }
  if (typeof candidate.version !== 'number' || candidate.version > BACKUP_VERSION) {
    throw new ImportError(
      `That backup was written by a newer version of the app (format ${String(candidate.version)}).`,
    );
  }

  const profiles = Array.isArray(candidate.profiles) ? candidate.profiles : [];
  const measurements = Array.isArray(candidate.measurements) ? candidate.measurements : [];

  const validProfiles = profiles.filter(isProfileLike);
  const validMeasurements = measurements.filter(isMeasurementLike);

  if (validProfiles.length !== profiles.length || validMeasurements.length !== measurements.length) {
    throw new ImportError(
      'That backup contains damaged records. Nothing was imported, so the current data is untouched.',
    );
  }

  return {
    format: BACKUP_FORMAT,
    version: candidate.version,
    exportedAt: typeof candidate.exportedAt === 'string' ? candidate.exportedAt : '',
    appVersion: typeof candidate.appVersion === 'string' ? candidate.appVersion : 'unknown',
    profiles: validProfiles,
    measurements: validMeasurements,
  };
}

function isProfileLike(value: unknown): value is CalibrationProfile {
  if (typeof value !== 'object' || value === null) return false;
  const profile = value as Partial<CalibrationProfile>;
  return (
    typeof profile.id === 'string' &&
    typeof profile.name === 'string' &&
    (profile.mode === 'raw' || profile.mode === 'live') &&
    Array.isArray(profile.points) &&
    profile.points.every(
      (point) =>
        typeof point === 'object' &&
        point !== null &&
        Number.isFinite((point as { measured: number }).measured) &&
        Number.isFinite((point as { referenceKelvin: number }).referenceKelvin),
    ) &&
    Number.isFinite(profile.miredTrim ?? 0) &&
    Number.isFinite(profile.tintOffset ?? 0)
  );
}

function isMeasurementLike(value: unknown): value is StoredMeasurement {
  if (typeof value !== 'object' || value === null) return false;
  const measurement = value as Partial<StoredMeasurement>;
  return (
    typeof measurement.id === 'string' &&
    typeof measurement.sessionId === 'string' &&
    Number.isFinite(measurement.kelvin) &&
    Number.isFinite(measurement.createdAt)
  );
}

/**
 * Merge an imported backup with what is already stored.
 *
 * Records are matched by id and the newer `updatedAt` wins, so importing the
 * same backup twice is a no-op and importing an older one does not undo newer
 * work. Nothing is ever deleted by an import.
 */
export function mergeProfiles(
  existing: readonly CalibrationProfile[],
  incoming: readonly CalibrationProfile[],
): { merged: CalibrationProfile[]; added: number; updated: number; skipped: number } {
  const byId = new Map(existing.map((profile) => [profile.id, profile]));
  let added = 0;
  let updated = 0;
  let skipped = 0;

  for (const profile of incoming) {
    const current = byId.get(profile.id);
    if (!current) {
      byId.set(profile.id, profile);
      added++;
    } else if ((profile.updatedAt ?? 0) > (current.updatedAt ?? 0)) {
      byId.set(profile.id, profile);
      updated++;
    } else {
      skipped++;
    }
  }

  return { merged: [...byId.values()], added, updated, skipped };
}

export function mergeMeasurements(
  existing: readonly StoredMeasurement[],
  incoming: readonly StoredMeasurement[],
): { merged: StoredMeasurement[]; added: number; skipped: number } {
  const byId = new Map(existing.map((measurement) => [measurement.id, measurement]));
  let added = 0;
  let skipped = 0;

  for (const measurement of incoming) {
    if (byId.has(measurement.id)) {
      skipped++;
    } else {
      byId.set(measurement.id, measurement);
      added++;
    }
  }

  return { merged: [...byId.values()], added, skipped };
}

/* -------------------------------------------------------------------- */
/* CSV                                                                   */
/* -------------------------------------------------------------------- */

const CSV_COLUMNS = [
  'session',
  'room',
  'kelvin',
  'tint',
  'duv',
  'x',
  'y',
  'mode',
  'calibrated',
  'profile',
  'source',
  'note',
  'timestamp',
] as const;

export function measurementsToCsv(measurements: readonly StoredMeasurement[]): string {
  const rows = [CSV_COLUMNS.join(',')];
  for (const measurement of measurements) {
    rows.push(
      [
        measurement.sessionName,
        measurement.label,
        Math.round(measurement.kelvin),
        Math.round(measurement.tint),
        measurement.duv.toFixed(4),
        measurement.x.toFixed(4),
        measurement.y.toFixed(4),
        measurement.mode,
        measurement.calibrated ? 'yes' : 'no',
        measurement.profileName ?? '',
        measurement.source,
        measurement.note,
        new Date(measurement.createdAt).toISOString(),
      ]
        .map(csvCell)
        .join(','),
    );
  }
  return rows.join('\n');
}

/**
 * Quote a CSV cell.
 *
 * The leading-character guard stops a spreadsheet from treating a room label
 * like "=Kitchen" as a formula. A shoot log is the sort of file that gets
 * opened in Excel by whoever receives it.
 */
function csvCell(value: string | number): string {
  let text = String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

/** Plain-text summary, the format a shoot log actually gets pasted into. */
export function measurementsToText(measurements: readonly StoredMeasurement[]): string {
  return measurements
    .map((measurement) => {
      const tint = Math.round(measurement.tint);
      const tintText = tint === 0 ? '' : ` / tint ${tint > 0 ? '+' : ''}${tint}`;
      const approximate = measurement.mode === 'live' ? ' (approx)' : '';
      return `${measurement.label || 'unlabelled'} ${Math.round(measurement.kelvin)} K${tintText}${approximate}`;
    })
    .join('\n');
}
