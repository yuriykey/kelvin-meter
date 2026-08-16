/**
 * IndexedDB persistence.
 *
 * iOS evicts web app storage from sites the user has not visited in a while,
 * and a home-screen PWA is not exempt. Losing a calibration set that took a
 * bi-colour panel and half an hour to build is a real cost, so export is
 * treated as part of the calibration workflow rather than as a convenience —
 * see `exportImport.ts` and the prompt the calibration screen raises after
 * any change.
 */

import type { CalibrationProfile } from '../calibration/index.ts';
import type { MeasurementMode } from '../color/index.ts';

export const DB_NAME = 'kelvinmeter';
export const DB_VERSION = 1;

export const STORE = {
  profiles: 'profiles',
  measurements: 'measurements',
  settings: 'settings',
} as const;

export interface StoredMeasurement {
  readonly id: string;
  readonly sessionId: string;
  readonly sessionName: string;
  readonly label: string;
  readonly mode: MeasurementMode;
  readonly kelvin: number;
  readonly tint: number;
  readonly duv: number;
  readonly x: number;
  readonly y: number;
  readonly calibrated: boolean;
  readonly profileId: string | null;
  readonly profileName: string | null;
  readonly source: string;
  readonly note: string;
  readonly createdAt: number;
}

export interface Settings {
  readonly id: 'settings';
  readonly activeRawProfileId: string | null;
  readonly activeLiveProfileId: string | null;
  readonly currentSessionId: string;
  readonly currentSessionName: string;
  readonly exportReminderPending: boolean;
  readonly lastExportAt: number | null;
}

export const DEFAULT_SETTINGS: Settings = {
  id: 'settings',
  activeRawProfileId: null,
  activeLiveProfileId: null,
  currentSessionId: 'session_initial',
  currentSessionName: 'Session 1',
  exportReminderPending: false,
  lastExportAt: null,
};

let dbPromise: Promise<IDBDatabase> | null = null;

export function storageAvailable(): boolean {
  return typeof indexedDB !== 'undefined';
}

export function openDatabase(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    if (!storageAvailable()) {
      reject(new Error('IndexedDB is not available in this browser'));
      return;
    }

    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE.profiles)) {
        db.createObjectStore(STORE.profiles, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORE.measurements)) {
        const store = db.createObjectStore(STORE.measurements, { keyPath: 'id' });
        store.createIndex('sessionId', 'sessionId', { unique: false });
        store.createIndex('createdAt', 'createdAt', { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE.settings)) {
        db.createObjectStore(STORE.settings, { keyPath: 'id' });
      }
    };

    request.onsuccess = () => {
      const db = request.result;
      // If another tab upgrades the schema, this connection must let go or it
      // will block that tab indefinitely.
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };

    request.onerror = () => reject(request.error ?? new Error('IndexedDB refused to open'));
    request.onblocked = () =>
      reject(new Error('Another tab is holding an older version of the database open'));
  });

  return dbPromise;
}

function runTransaction<T>(
  storeName: string,
  mode: IDBTransactionMode,
  action: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return openDatabase().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const transaction = db.transaction(storeName, mode);
        const request = action(transaction.objectStore(storeName));
        transaction.onerror = () =>
          reject(transaction.error ?? new Error('Database transaction failed'));
        transaction.onabort = () =>
          reject(transaction.error ?? new Error('Database transaction aborted'));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error('Database request failed'));
      }),
  );
}

/* -------------------------------------------------------------------- */
/* Profiles                                                              */
/* -------------------------------------------------------------------- */

export async function listProfiles(): Promise<CalibrationProfile[]> {
  const profiles = await runTransaction<CalibrationProfile[]>(
    STORE.profiles,
    'readonly',
    (store) => store.getAll() as IDBRequest<CalibrationProfile[]>,
  );
  return profiles.sort((a, b) => a.name.localeCompare(b.name));
}

export async function saveProfile(profile: CalibrationProfile): Promise<void> {
  await runTransaction(STORE.profiles, 'readwrite', (store) => store.put(profile));
}

export async function deleteProfile(id: string): Promise<void> {
  await runTransaction(STORE.profiles, 'readwrite', (store) => store.delete(id));
}

/* -------------------------------------------------------------------- */
/* Measurements                                                          */
/* -------------------------------------------------------------------- */

export async function listMeasurements(): Promise<StoredMeasurement[]> {
  const measurements = await runTransaction<StoredMeasurement[]>(
    STORE.measurements,
    'readonly',
    (store) => store.getAll() as IDBRequest<StoredMeasurement[]>,
  );
  return measurements.sort((a, b) => b.createdAt - a.createdAt);
}

export async function saveMeasurement(measurement: StoredMeasurement): Promise<void> {
  await runTransaction(STORE.measurements, 'readwrite', (store) => store.put(measurement));
}

export async function deleteMeasurement(id: string): Promise<void> {
  await runTransaction(STORE.measurements, 'readwrite', (store) => store.delete(id));
}

/* -------------------------------------------------------------------- */
/* Settings                                                              */
/* -------------------------------------------------------------------- */

export async function loadSettings(): Promise<Settings> {
  const stored = await runTransaction<Settings | undefined>(
    STORE.settings,
    'readonly',
    (store) => store.get('settings') as IDBRequest<Settings | undefined>,
  );
  return { ...DEFAULT_SETTINGS, ...(stored ?? {}) };
}

export async function saveSettings(settings: Settings): Promise<void> {
  await runTransaction(STORE.settings, 'readwrite', (store) => store.put(settings));
}

/**
 * Ask the browser to keep this origin's storage. Safari does not grant it,
 * but Chrome does, and asking costs nothing. The export prompt is the real
 * defence either way.
 */
export async function requestPersistentStorage(): Promise<boolean> {
  if (typeof navigator === 'undefined' || !navigator.storage?.persist) return false;
  try {
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}
