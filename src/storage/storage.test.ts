import { describe, expect, it } from 'vitest';
import {
  BACKUP_FORMAT,
  ImportError,
  buildBackup,
  measurementsToCsv,
  measurementsToText,
  mergeMeasurements,
  mergeProfiles,
  parseBackup,
  serialiseBackup,
} from './exportImport.ts';
import { createProfile } from '../calibration/index.ts';
import type { StoredMeasurement } from './db.ts';

function measurement(overrides: Partial<StoredMeasurement> = {}): StoredMeasurement {
  return {
    id: 'm1',
    sessionId: 's1',
    sessionName: 'Elm Street',
    label: 'Kitchen',
    mode: 'raw',
    kelvin: 2750,
    tint: 6,
    duv: 0.0031,
    x: 0.4512,
    y: 0.4088,
    calibrated: true,
    profileId: 'p1',
    profileName: 'ProRAW',
    source: 'AsShotNeutral',
    note: '',
    createdAt: 1_700_000_000_000,
    ...overrides,
  };
}

describe('backup round trip', () => {
  it('survives serialise then parse unchanged', () => {
    const profile = createProfile({ name: 'ProRAW / iPhone', mode: 'raw' });
    const backup = buildBackup([profile], [measurement()], '1.0.0');
    const restored = parseBackup(serialiseBackup(backup));
    expect(restored.profiles).toEqual([profile]);
    expect(restored.measurements).toEqual([measurement()]);
    expect(restored.format).toBe(BACKUP_FORMAT);
  });

  it('rejects files that are not JSON', () => {
    expect(() => parseBackup('not json at all')).toThrow(ImportError);
    expect(() => parseBackup('not json at all')).toThrow(/not valid json/i);
  });

  it('rejects JSON that is not a backup', () => {
    expect(() => parseBackup('{"hello":"world"}')).toThrow(/not a kelvinmeter backup/i);
    expect(() => parseBackup('[1,2,3]')).toThrow(ImportError);
    expect(() => parseBackup('null')).toThrow(ImportError);
  });

  it('refuses a backup from a newer format version rather than guessing', () => {
    const future = JSON.stringify({ format: BACKUP_FORMAT, version: 99, profiles: [], measurements: [] });
    expect(() => parseBackup(future)).toThrow(/newer version/i);
  });

  it('refuses a partially damaged backup instead of importing half of it', () => {
    const damaged = JSON.stringify({
      format: BACKUP_FORMAT,
      version: 1,
      profiles: [createProfile({ name: 'ok', mode: 'raw' }), { id: 'broken' }],
      measurements: [],
    });
    expect(() => parseBackup(damaged)).toThrow(/damaged/i);
  });

  it('rejects a profile whose points are not numeric', () => {
    const bad = JSON.stringify({
      format: BACKUP_FORMAT,
      version: 1,
      profiles: [
        {
          ...createProfile({ name: 'bad', mode: 'raw' }),
          points: [{ measured: 'warm', referenceKelvin: 3200 }],
        },
      ],
      measurements: [],
    });
    expect(() => parseBackup(bad)).toThrow(ImportError);
  });

  it('accepts a backup with no measurements', () => {
    const backup = JSON.stringify({ format: BACKUP_FORMAT, version: 1, profiles: [] });
    expect(parseBackup(backup).measurements).toEqual([]);
  });
});

describe('merging an import with existing data', () => {
  const older = { ...createProfile({ name: 'A', mode: 'raw' }), id: 'p1', updatedAt: 100 };
  const newer = { ...older, name: 'A renamed', updatedAt: 200 };

  it('adds profiles that are not present', () => {
    const result = mergeProfiles([], [older]);
    expect(result.added).toBe(1);
    expect(result.merged).toHaveLength(1);
  });

  it('lets the newer record win', () => {
    const result = mergeProfiles([older], [newer]);
    expect(result.updated).toBe(1);
    expect(result.merged[0]!.name).toBe('A renamed');
  });

  it('does not let an older import undo newer work', () => {
    const result = mergeProfiles([newer], [older]);
    expect(result.skipped).toBe(1);
    expect(result.merged[0]!.name).toBe('A renamed');
  });

  it('makes importing the same backup twice a no-op', () => {
    const first = mergeProfiles([], [newer]);
    const second = mergeProfiles(first.merged, [newer]);
    expect(second.merged).toEqual(first.merged);
    expect(second.added).toBe(0);
    expect(second.updated).toBe(0);
  });

  it('never deletes anything on import', () => {
    const keep = { ...createProfile({ name: 'keep', mode: 'live' }), id: 'p9' };
    const result = mergeProfiles([keep], [newer]);
    expect(result.merged.map((p) => p.id).sort()).toEqual(['p1', 'p9']);
  });

  it('deduplicates measurements by id', () => {
    const result = mergeMeasurements([measurement()], [measurement(), measurement({ id: 'm2' })]);
    expect(result.added).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.merged).toHaveLength(2);
  });
});

describe('CSV export', () => {
  it('writes a header and one row per measurement', () => {
    const csv = measurementsToCsv([measurement(), measurement({ id: 'm2', label: 'Primary bath' })]);
    const lines = csv.split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('session,room,kelvin,tint');
    expect(lines[1]).toContain('Kitchen');
    expect(lines[2]).toContain('Primary bath');
  });

  it('quotes cells containing commas, quotes and newlines', () => {
    const csv = measurementsToCsv([
      measurement({ label: 'Kitchen, north', note: 'said "warm"' }),
    ]);
    expect(csv).toContain('"Kitchen, north"');
    expect(csv).toContain('"said ""warm"""');
  });

  it('neutralises cells a spreadsheet would treat as a formula', () => {
    // A shoot log gets opened in Excel by whoever receives it.
    const csv = measurementsToCsv([measurement({ label: '=SUM(A1:A9)' })]);
    expect(csv).toContain("'=SUM(A1:A9)");
    expect(csv).not.toMatch(/,=SUM/);
  });

  it('rounds Kelvin and tint but keeps Duv and xy at full precision', () => {
    const csv = measurementsToCsv([measurement({ kelvin: 2749.6, tint: 5.7, duv: 0.00312 })]);
    expect(csv).toContain('2750');
    expect(csv).toContain('6');
    expect(csv).toContain('0.0031');
  });
});

describe('plain text shoot log', () => {
  it('reads the way a photographer would write it', () => {
    const text = measurementsToText([
      measurement({ label: 'kitchen', kelvin: 2750, tint: 0 }),
      measurement({ id: 'm2', label: 'living room', kelvin: 4100, tint: 0 }),
      measurement({ id: 'm3', label: 'windows', kelvin: 6200, tint: 0 }),
    ]);
    expect(text).toBe('kitchen 2750 K\nliving room 4100 K\nwindows 6200 K');
  });

  it('includes tint when it is not zero', () => {
    expect(measurementsToText([measurement({ label: 'kitchen', tint: 8 })])).toBe(
      'kitchen 2750 K / tint +8',
    );
    expect(measurementsToText([measurement({ label: 'kitchen', tint: -8 })])).toBe(
      'kitchen 2750 K / tint -8',
    );
  });

  it('marks live readings as approximate so they are never mistaken for raw', () => {
    const text = measurementsToText([measurement({ mode: 'live', label: 'hall', tint: 0 })]);
    expect(text).toContain('(approx)');
  });

  it('handles an unlabelled measurement', () => {
    expect(measurementsToText([measurement({ label: '', tint: 0 })])).toBe('unlabelled 2750 K');
  });
});
