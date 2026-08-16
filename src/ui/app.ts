/**
 * Application shell: state, actions, and the render loop.
 *
 * State lives in one object and every action produces a new one, then the
 * screen is rebuilt. For an app of this size that is simpler and more
 * predictable than incremental updates, and the render is cheap enough that
 * the live preview stays smooth — the video element is deliberately kept
 * outside the rebuilt tree so it never restarts.
 */

import type { MeasurementMode } from '../color/index.ts';
import type { CalibrationProfile } from '../calibration/index.ts';
import { createProfile, newId } from '../calibration/index.ts';
import { readDngFile, describeDngError } from '../dng/index.ts';
import { type Reading, readingFromDng, readingFromLive } from '../reading.ts';
import {
  DEFAULT_SETTINGS,
  type Settings,
  type StoredMeasurement,
  deleteMeasurement,
  deleteProfile,
  listMeasurements,
  listProfiles,
  loadSettings,
  requestPersistentStorage,
  saveMeasurement,
  saveProfile,
  saveSettings,
  storageAvailable,
} from '../storage/db.ts';
import { APP_VERSION } from '../version.ts';
import {
  buildBackup,
  mergeMeasurements,
  mergeProfiles,
  parseBackup,
  serialiseBackup,
} from '../storage/exportImport.ts';
import { clear, downloadText, el } from './dom.ts';
import { LiveController, type LiveFrame } from './liveController.ts';
import { renderMeasureScreen } from './measureScreen.ts';
import { renderLogScreen } from './logScreen.ts';
import { renderCalibrateScreen } from './calibrateScreen.ts';
import { renderAboutScreen } from './aboutScreen.ts';

export type ScreenName = 'measure' | 'log' | 'calibrate' | 'about';

export interface AppState {
  readonly screen: ScreenName;
  readonly mode: MeasurementMode;
  readonly reading: Reading | null;
  readonly held: boolean;
  readonly profiles: readonly CalibrationProfile[];
  readonly measurements: readonly StoredMeasurement[];
  readonly settings: Settings;
  readonly toast: string | null;
  readonly storageError: string | null;
  readonly liveError: string | null;
  readonly liveFrame: LiveFrame | null;
  readonly applyUpdate: (() => void) | null;
  readonly busy: boolean;
}

const SCREENS: readonly { id: ScreenName; label: string }[] = [
  { id: 'measure', label: 'Measure' },
  { id: 'log', label: 'Log' },
  { id: 'calibrate', label: 'Calibrate' },
  { id: 'about', label: 'Guide' },
];

export class App {
  private state: AppState = {
    screen: 'measure',
    mode: 'raw',
    reading: null,
    held: false,
    profiles: [],
    measurements: [],
    settings: DEFAULT_SETTINGS,
    toast: null,
    storageError: null,
    liveError: null,
    liveFrame: null,
    applyUpdate: null,
    busy: false,
  };

  private toastTimer: number | null = null;
  /** Which screen+mode the DOM currently shows, for scroll preservation. */
  private lastRenderedView: string | null = null;
  readonly live: LiveController;

  constructor(private readonly root: HTMLElement) {
    this.live = new LiveController(
      (frame) => this.handleLiveFrame(frame),
      (message) => this.patch({ liveError: message }),
    );
  }

  get current(): AppState {
    return this.state;
  }

  /* ------------------------------------------------------------ lifecycle */

  async init(): Promise<void> {
    if (!storageAvailable()) {
      this.patch({
        storageError:
          'This browser has no IndexedDB, so calibrations and measurements cannot be saved. Everything else still works.',
      });
      this.render();
      return;
    }

    try {
      const [profiles, measurements, settings] = await Promise.all([
        listProfiles(),
        listMeasurements(),
        loadSettings(),
      ]);
      this.patch({ profiles, measurements, settings });
      void requestPersistentStorage();
    } catch (error) {
      this.patch({
        storageError: `Stored data could not be opened: ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
    }
    this.render();
  }

  private patch(changes: Partial<AppState>): void {
    this.state = { ...this.state, ...changes };
  }

  private update(changes: Partial<AppState>): void {
    this.patch(changes);
    this.render();
  }

  /* --------------------------------------------------------------- render */

  render(): void {
    // Scroll is preserved across re-renders of the same view — a toast
    // appearing must not jump the page — but deliberately reset when the
    // screen or mode changes. Carrying it over meant arriving at the measure
    // screen already scrolled past the reading, which is the one thing on it.
    const viewKey = `${this.state.screen}:${this.state.mode}`;
    const sameView = viewKey === this.lastRenderedView;
    const previousScroll = sameView
      ? (this.root.querySelector('.screen')?.scrollTop ?? 0)
      : 0;
    this.lastRenderedView = viewKey;

    clear(this.root);

    if (this.state.applyUpdate) {
      this.root.appendChild(
        banner(
          'A newer build is ready.',
          'Reload',
          () => this.state.applyUpdate?.(),
          false,
        ),
      );
    }
    if (this.state.settings.exportReminderPending) {
      this.root.appendChild(
        banner(
          'Calibration changed. Export a backup — iOS can evict this app’s storage.',
          'Export',
          () => void this.exportBackup(),
          true,
        ),
      );
    }
    if (this.state.storageError) {
      this.root.appendChild(
        banner(this.state.storageError, 'Dismiss', () => this.update({ storageError: null }), true),
      );
    }

    this.root.appendChild(this.renderScreen());
    this.root.appendChild(this.renderTabBar());

    if (this.state.toast) {
      this.root.appendChild(el('div', { class: 'toast', role: 'status' }, this.state.toast));
    }

    const screen = this.root.querySelector('.screen');
    if (screen && previousScroll > 0) screen.scrollTop = previousScroll;
  }

  private renderScreen(): HTMLElement {
    switch (this.state.screen) {
      case 'measure':
        return renderMeasureScreen(this.state, this.actions, this.live);
      case 'log':
        return renderLogScreen(this.state, this.actions);
      case 'calibrate':
        return renderCalibrateScreen(this.state, this.actions);
      case 'about':
        return renderAboutScreen(this.state, this.actions, this.live);
    }
  }

  private renderTabBar(): HTMLElement {
    const bar = el('nav', { class: 'tabbar', 'aria-label': 'Screens' });
    for (const screen of SCREENS) {
      const isCurrent = this.state.screen === screen.id;
      const tab = el(
        'button',
        { type: 'button', ...(isCurrent ? { 'aria-current': 'page' } : {}) },
        screen.label,
      );
      tab.addEventListener('click', () => this.actions.goTo(screen.id));
      bar.appendChild(tab);
    }
    return bar;
  }

  /* -------------------------------------------------------------- actions */

  readonly actions = {
    goTo: (screen: ScreenName): void => {
      // The camera is released whenever the measure screen is not visible.
      // Leaving it running keeps the privacy indicator lit and drains the
      // battery for a preview nobody is looking at.
      if (screen !== 'measure' && this.live.active) this.live.stop();
      this.update({ screen });
      if (screen === 'measure' && this.state.mode === 'live') void this.startLive();
    },

    setMode: (mode: MeasurementMode): void => {
      if (mode === this.state.mode) return;
      if (mode === 'raw') this.live.stop();
      this.update({ mode, reading: null, held: false, liveError: null, liveFrame: null });
      if (mode === 'live') void this.startLive();
    },

    importFile: async (file: File): Promise<void> => {
      this.update({ busy: true });
      try {
        const result = await readDngFile(file);
        const profile = this.activeProfile('raw');
        this.update({
          reading: readingFromDng(result.solve, profile, result.fileName),
          held: false,
          busy: false,
        });
      } catch (error) {
        this.update({
          busy: false,
          reading: {
            mode: 'raw',
            kelvin: Number.NaN,
            tint: Number.NaN,
            rawKelvin: Number.NaN,
            rawTint: Number.NaN,
            duv: Number.NaN,
            xy: { x: Number.NaN, y: Number.NaN },
            calibrated: false,
            extrapolated: false,
            profileName: null,
            profileId: null,
            source: 'none',
            feature: null,
            warnings: [
              {
                kind: 'UNSUPPORTED FILE',
                detail: describeDngError(error),
                blocking: true,
              },
            ],
            details: [{ label: 'File', value: file.name }],
            createdAt: Date.now(),
          },
        });
      }
    },

    toggleHold: (): void => {
      this.update({ held: !this.state.held });
    },

    saveReading: async (label: string, note: string): Promise<void> => {
      const reading = this.state.reading;
      if (!reading || !Number.isFinite(reading.kelvin)) {
        this.toast('Nothing to save yet.');
        return;
      }
      const measurement: StoredMeasurement = {
        id: newId('m'),
        sessionId: this.state.settings.currentSessionId,
        sessionName: this.state.settings.currentSessionName,
        label: label.trim(),
        mode: reading.mode,
        kelvin: reading.kelvin,
        tint: Number.isFinite(reading.tint) ? reading.tint : 0,
        duv: Number.isFinite(reading.duv) ? reading.duv : 0,
        x: Number.isFinite(reading.xy.x) ? reading.xy.x : 0,
        y: Number.isFinite(reading.xy.y) ? reading.xy.y : 0,
        calibrated: reading.calibrated,
        profileId: reading.profileId,
        profileName: reading.profileName,
        source: reading.source,
        note: note.trim(),
        createdAt: Date.now(),
      };

      try {
        await saveMeasurement(measurement);
        this.update({ measurements: [measurement, ...this.state.measurements] });
        this.toast(`Saved ${label.trim() || 'reading'}.`);
      } catch (error) {
        this.toast(`Could not save: ${errorText(error)}`);
      }
    },

    deleteMeasurement: async (id: string): Promise<void> => {
      try {
        await deleteMeasurement(id);
        this.update({
          measurements: this.state.measurements.filter((item) => item.id !== id),
        });
      } catch (error) {
        this.toast(`Could not delete: ${errorText(error)}`);
      }
    },

    startNewSession: async (name: string): Promise<void> => {
      const settings: Settings = {
        ...this.state.settings,
        currentSessionId: newId('session'),
        currentSessionName: name.trim() || 'Untitled session',
      };
      await this.persistSettings(settings);
      this.toast(`Started "${settings.currentSessionName}".`);
    },

    renameSession: async (name: string): Promise<void> => {
      const settings: Settings = {
        ...this.state.settings,
        currentSessionName: name.trim() || this.state.settings.currentSessionName,
      };
      await this.persistSettings(settings);
    },

    createProfile: async (
      name: string,
      mode: MeasurementMode,
      notes: string,
      cardId: string | null,
    ): Promise<void> => {
      const profile = createProfile({ name: name.trim() || 'Untitled profile', mode, notes, cardId });
      await this.storeProfile(profile, false);
      await this.actions.setActiveProfile(mode, profile.id);
      this.toast(`Created "${profile.name}".`);
    },

    updateProfile: async (profile: CalibrationProfile): Promise<void> => {
      await this.storeProfile(profile, true);
    },

    deleteProfile: async (id: string): Promise<void> => {
      try {
        await deleteProfile(id);
        const profiles = this.state.profiles.filter((profile) => profile.id !== id);
        const settings: Settings = {
          ...this.state.settings,
          activeRawProfileId:
            this.state.settings.activeRawProfileId === id
              ? null
              : this.state.settings.activeRawProfileId,
          activeLiveProfileId:
            this.state.settings.activeLiveProfileId === id
              ? null
              : this.state.settings.activeLiveProfileId,
        };
        this.patch({ profiles });
        await this.persistSettings(settings);
      } catch (error) {
        this.toast(`Could not delete: ${errorText(error)}`);
      }
    },

    setActiveProfile: async (mode: MeasurementMode, id: string | null): Promise<void> => {
      const settings: Settings = {
        ...this.state.settings,
        ...(mode === 'raw' ? { activeRawProfileId: id } : { activeLiveProfileId: id }),
      };
      await this.persistSettings(settings);
      this.recomputeReading();
    },

    exportBackup: (): Promise<void> => this.exportBackup(),

    importBackup: async (text: string): Promise<void> => {
      try {
        const backup = parseBackup(text);
        const profileMerge = mergeProfiles(this.state.profiles, backup.profiles);
        const measurementMerge = mergeMeasurements(this.state.measurements, backup.measurements);

        for (const profile of profileMerge.merged) await saveProfile(profile);
        for (const measurement of measurementMerge.merged) await saveMeasurement(measurement);

        this.update({
          profiles: profileMerge.merged.sort((a, b) => a.name.localeCompare(b.name)),
          measurements: measurementMerge.merged.sort((a, b) => b.createdAt - a.createdAt),
        });
        this.toast(
          `Imported ${profileMerge.added} new and ${profileMerge.updated} updated profiles, ` +
            `${measurementMerge.added} measurements.`,
        );
      } catch (error) {
        this.toast(errorText(error));
      }
    },

    toast: (message: string): void => this.toast(message),

    dismissExportReminder: async (): Promise<void> => {
      await this.persistSettings({ ...this.state.settings, exportReminderPending: false });
    },

    setUpdateAvailable: (apply: () => void): void => {
      this.update({ applyUpdate: apply });
    },

    refresh: (): void => this.render(),
  };

  /* -------------------------------------------------------------- helpers */

  activeProfile(mode: MeasurementMode): CalibrationProfile | null {
    const id =
      mode === 'raw'
        ? this.state.settings.activeRawProfileId
        : this.state.settings.activeLiveProfileId;
    if (!id) return null;
    return this.state.profiles.find((profile) => profile.id === id) ?? null;
  }

  /** Re-apply calibration to whatever is on screen after a profile change. */
  private recomputeReading(): void {
    const reading = this.state.reading;
    if (!reading) {
      this.render();
      return;
    }
    if (reading.mode === 'live' && this.state.liveFrame) {
      this.handleLiveFrame(this.state.liveFrame);
      return;
    }
    this.render();
  }

  private handleLiveFrame(frame: LiveFrame): void {
    if (this.state.held) {
      this.patch({ liveFrame: frame });
      return;
    }
    const reading = readingFromLive(
      {
        features: frame.features,
        featureSpread: frame.featureSpread,
        stabilityReady: frame.stabilityReady,
      },
      this.activeProfile('live'),
    );
    this.update({ reading, liveFrame: frame });
  }

  private async startLive(): Promise<void> {
    this.patch({ liveError: null });
    await this.live.start();
    this.render();
  }

  private async storeProfile(profile: CalibrationProfile, replace: boolean): Promise<void> {
    try {
      await saveProfile(profile);
      const profiles = replace
        ? this.state.profiles.map((item) => (item.id === profile.id ? profile : item))
        : [...this.state.profiles, profile];
      this.patch({ profiles: profiles.sort((a, b) => a.name.localeCompare(b.name)) });
      // Any calibration change makes the stored data more valuable and more
      // painful to lose, so the export prompt is raised every time.
      await this.persistSettings({ ...this.state.settings, exportReminderPending: true });
      this.recomputeReading();
    } catch (error) {
      this.toast(`Could not save profile: ${errorText(error)}`);
    }
  }

  private async persistSettings(settings: Settings): Promise<void> {
    this.patch({ settings });
    try {
      await saveSettings(settings);
    } catch (error) {
      this.patch({ storageError: `Settings could not be saved: ${errorText(error)}` });
    }
    this.render();
  }

  private async exportBackup(): Promise<void> {
    const backup = buildBackup(this.state.profiles, this.state.measurements, APP_VERSION);
    const text = serialiseBackup(backup);
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    downloadText(`kelvinmeter-backup-${stamp}.json`, 'application/json', text);
    await this.persistSettings({
      ...this.state.settings,
      exportReminderPending: false,
      lastExportAt: Date.now(),
    });
    this.toast('Backup exported.');
  }

  private toast(message: string): void {
    if (this.toastTimer !== null) window.clearTimeout(this.toastTimer);
    this.update({ toast: message });
    this.toastTimer = window.setTimeout(() => {
      this.toastTimer = null;
      this.update({ toast: null });
    }, 3200);
  }
}

function banner(
  message: string,
  actionLabel: string,
  onAction: () => void,
  warn: boolean,
): HTMLElement {
  const node = el('div', { class: warn ? 'banner banner--warn' : 'banner' }, el('span', {}, message));
  const action = el('button', { type: 'button' }, actionLabel);
  action.addEventListener('click', onAction);
  node.appendChild(action);
  return node;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
