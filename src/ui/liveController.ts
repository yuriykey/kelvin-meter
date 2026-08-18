/**
 * Drives the live camera loop.
 *
 * Kept out of the render path: the video element is created once and reused,
 * because tearing down and restarting a camera stream on every re-render
 * would make the preview flicker and would spend a second re-acquiring the
 * camera each time.
 */

import {
  CameraError,
  FrameGrabber,
  StabilityTracker,
  cardGrid,
  cellRect,
  computeFeatures,
  describeCapabilities,
  samplePatch,
  startCamera,
  stopStream,
  type CameraCapabilityReport,
  type CardGrid,
  type FeatureResult,
  type PatchReading,
  type ReferenceCard,
  type SampleRect,
} from '../live/index.ts';
import { REFERENCE_CARDS } from '../live/index.ts';

export interface LiveFrame {
  readonly features: FeatureResult;
  readonly featureSpread: number;
  readonly stabilityReady: boolean;
  readonly grid: CardGrid;
}

export type LiveFrameHandler = (frame: LiveFrame) => void;
export type LiveErrorHandler = (message: string) => void;

/** How often the reading updates. Faster than this just burns battery. */
const SAMPLE_INTERVAL_MS = 200;

export class LiveController {
  readonly video: HTMLVideoElement;
  private stream: MediaStream | null = null;
  private grabber = new FrameGrabber();
  private tracker = new StabilityTracker();
  private timer: number | null = null;
  private running = false;
  /** Which card's layout the grid is drawn for. */
  private card: ReferenceCard = REFERENCE_CARDS[0]!;
  /**
   * Frame aspect of the most recent grab. The grid has to be laid out for the
   * frame the pixels actually come from, not for the shape of the box on
   * screen; those were different, and the overlay was pointing at pixels the
   * app was not reading.
   */
  private frameAspect = 4 / 3;
  /**
   * Capability snapshot taken while the track was live.
   *
   * The camera is released whenever the measure screen is not on screen, so by
   * the time the Guide screen renders there is no track left to interrogate.
   * Without this the one screen whose job is to report the camera's real
   * capabilities could never show them.
   */
  private lastCapabilityReport: CameraCapabilityReport | null = null;

  constructor(
    private readonly onFrame: LiveFrameHandler,
    private readonly onError: LiveErrorHandler,
  ) {
    this.video = document.createElement('video');
    this.video.playsInline = true;
    this.video.muted = true;
    this.video.autoplay = true;
    // Safari needs the attribute as well as the property for inline playback.
    this.video.setAttribute('playsinline', '');
    this.video.setAttribute('muted', '');
  }

  get active(): boolean {
    return this.running;
  }

  get currentStream(): MediaStream | null {
    return this.stream;
  }

  setCard(card: ReferenceCard): void {
    this.card = card;
  }

  get activeCard(): ReferenceCard {
    return this.card;
  }

  /** Grid the overlay must draw, in frame coordinates. */
  get grid(): CardGrid {
    return cardGrid(this.card.rows, this.card.columns, this.frameAspect);
  }

  /** Aspect ratio of the frames being sampled, for sizing the preview box. */
  get videoAspect(): number {
    return this.frameAspect;
  }

  sampleRectFor(row: number, column: number): SampleRect {
    return cellRect(this.grid, row, column);
  }

  /** Live report if the camera is running, otherwise the last one captured. */
  capabilityReport(): CameraCapabilityReport {
    if (this.stream) {
      this.lastCapabilityReport = describeCapabilities(this.stream);
      return this.lastCapabilityReport;
    }
    return this.lastCapabilityReport ?? describeCapabilities(null);
  }

  async start(): Promise<void> {
    if (this.running) return;
    try {
      this.stream = await startCamera();
    } catch (error) {
      this.onError(
        error instanceof CameraError ? error.message : 'The camera could not be started.',
      );
      return;
    }

    this.video.srcObject = this.stream;
    try {
      await this.video.play();
    } catch {
      // Autoplay can be refused until the user interacts; the loop below still
      // runs and will pick up frames once playback starts.
    }

    this.running = true;
    this.tracker.clear();
    // Snapshot the capabilities now, while there is a track to ask.
    this.lastCapabilityReport = describeCapabilities(this.stream);
    this.timer = window.setInterval(() => this.sample(), SAMPLE_INTERVAL_MS);
  }

  stop(): void {
    this.running = false;
    if (this.timer !== null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
    stopStream(this.stream);
    this.stream = null;
    this.video.srcObject = null;
    this.tracker.clear();
  }

  dispose(): void {
    this.stop();
    this.grabber.dispose();
  }

  private sample(): void {
    if (!this.running) return;
    const frame = this.grabber.grab(this.video);
    if (!frame) return;

    this.frameAspect = frame.width / frame.height;
    const grid = this.grid;

    const readings: PatchReading[] = this.card.patches.map((patch) => ({
      role: patch.role,
      sample: samplePatch(
        frame.data,
        frame.width,
        frame.height,
        cellRect(grid, patch.row, patch.column),
      ),
    }));

    const features = computeFeatures(readings);
    if (Number.isFinite(features.warmth)) {
      this.tracker.push(features.warmth);
    }

    this.onFrame({
      features,
      featureSpread: this.tracker.standardDeviation,
      stabilityReady: this.tracker.ready,
      grid,
    });
  }
}
