/**
 * Camera access and capability reporting.
 *
 * iOS Safari exposes no white balance lock, no exposure lock, no ISO, no
 * focus control and no RAW. `getCapabilities()` on a video track returns
 * essentially nothing there, and Chrome and Firefox on iOS are the same
 * WebKit engine, so there is no escape hatch.
 *
 * Nothing in this module asks for `whiteBalanceMode`, `colorTemperature` or
 * `exposureMode`. Requesting them would be silently ignored and would leave
 * the impression that the frames are unprocessed. Instead the absence is
 * detected and reported, so what the app is actually working with is visible
 * on screen.
 */

export interface CameraCapabilityReport {
  readonly supportedConstraints: Record<string, boolean>;
  readonly trackCapabilities: Record<string, unknown> | null;
  readonly trackSettings: Record<string, unknown> | null;
  readonly deviceLabel: string | null;
  /** Constraints that would matter for measurement and are absent. */
  readonly missingForMeasurement: readonly string[];
  readonly userAgent: string;
  readonly capturedAt: string;
}

/** Constraints that would let a camera be used as an instrument. */
const MEASUREMENT_CONSTRAINTS = [
  'whiteBalanceMode',
  'colorTemperature',
  'exposureMode',
  'exposureTime',
  'exposureCompensation',
  'iso',
  'focusMode',
] as const;

export class CameraError extends Error {
  constructor(
    message: string,
    readonly kind: 'denied' | 'unavailable' | 'insecure' | 'unknown',
  ) {
    super(message);
    this.name = 'CameraError';
  }
}

export function cameraSupported(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    typeof navigator.mediaDevices?.getUserMedia === 'function'
  );
}

/**
 * `getUserMedia` needs a secure context. On a phone that means HTTPS or
 * localhost, which is worth saying explicitly because the failure otherwise
 * looks like a permissions bug.
 */
export function secureContextOk(): boolean {
  if (typeof window === 'undefined') return false;
  return window.isSecureContext === true;
}

export async function startCamera(): Promise<MediaStream> {
  if (!cameraSupported()) {
    throw new CameraError('This browser does not expose a camera to web pages.', 'unavailable');
  }
  if (!secureContextOk()) {
    throw new CameraError(
      'The camera needs a secure context. Open the app over HTTPS or on localhost.',
      'insecure',
    );
  }

  try {
    return await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 1280 },
        height: { ideal: 720 },
      },
      audio: false,
    });
  } catch (error) {
    const name = error instanceof Error ? error.name : '';
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      throw new CameraError(
        'Camera access was refused. Allow it in Settings, then reload.',
        'denied',
      );
    }
    if (name === 'NotFoundError' || name === 'OverconstrainedError') {
      throw new CameraError('No usable camera was found on this device.', 'unavailable');
    }
    throw new CameraError(
      error instanceof Error ? error.message : 'The camera could not be started.',
      'unknown',
    );
  }
}

export function stopStream(stream: MediaStream | null): void {
  if (!stream) return;
  for (const track of stream.getTracks()) track.stop();
}

/**
 * Snapshot of what this browser actually offers. Shown on the About screen
 * with a copy button, because the honest answer to "what can this measure"
 * depends entirely on the device it is running on.
 */
export function describeCapabilities(stream: MediaStream | null): CameraCapabilityReport {
  const supportedConstraints: Record<string, boolean> = {};
  if (typeof navigator !== 'undefined' && navigator.mediaDevices?.getSupportedConstraints) {
    const supported = navigator.mediaDevices.getSupportedConstraints() as Record<
      string,
      boolean
    >;
    for (const key of Object.keys(supported).sort()) {
      supportedConstraints[key] = Boolean(supported[key]);
    }
  }

  const track = stream?.getVideoTracks()[0] ?? null;

  let trackCapabilities: Record<string, unknown> | null = null;
  if (track && typeof track.getCapabilities === 'function') {
    try {
      trackCapabilities = JSON.parse(JSON.stringify(track.getCapabilities()));
    } catch {
      trackCapabilities = null;
    }
  }

  let trackSettings: Record<string, unknown> | null = null;
  if (track && typeof track.getSettings === 'function') {
    try {
      trackSettings = JSON.parse(JSON.stringify(track.getSettings()));
    } catch {
      trackSettings = null;
    }
  }

  const missingForMeasurement = MEASUREMENT_CONSTRAINTS.filter((name) => {
    const declaredSupported = supportedConstraints[name] === true;
    const presentOnTrack =
      trackCapabilities !== null && Object.prototype.hasOwnProperty.call(trackCapabilities, name);
    return !declaredSupported && !presentOnTrack;
  });

  return {
    supportedConstraints,
    trackCapabilities,
    trackSettings,
    deviceLabel: track?.label || null,
    missingForMeasurement,
    userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : 'unknown',
    capturedAt: new Date().toISOString(),
  };
}

export function formatCapabilityReport(report: CameraCapabilityReport): string {
  return JSON.stringify(report, null, 2);
}

/**
 * Reads frames from a video element into an offscreen canvas.
 *
 * `willReadFrequently` matters here: without it, browsers keep the canvas on
 * the GPU and every `getImageData` forces a readback stall.
 */
export class FrameGrabber {
  private canvas: HTMLCanvasElement | OffscreenCanvas | null = null;
  private context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null = null;

  grab(video: HTMLVideoElement, maxWidth = 640): ImageData | null {
    const sourceWidth = video.videoWidth;
    const sourceHeight = video.videoHeight;
    if (sourceWidth === 0 || sourceHeight === 0) return null;

    const scale = Math.min(1, maxWidth / sourceWidth);
    const width = Math.max(1, Math.round(sourceWidth * scale));
    const height = Math.max(1, Math.round(sourceHeight * scale));

    if (!this.canvas || this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas =
        typeof OffscreenCanvas !== 'undefined'
          ? new OffscreenCanvas(width, height)
          : Object.assign(document.createElement('canvas'), { width, height });
      this.canvas.width = width;
      this.canvas.height = height;
      this.context = this.canvas.getContext('2d', {
        willReadFrequently: true,
      }) as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
    }

    if (!this.context) return null;
    this.context.drawImage(video, 0, 0, width, height);
    try {
      return this.context.getImageData(0, 0, width, height);
    } catch {
      // Tainted canvas should be impossible for a same-origin camera stream,
      // but a null return is better than throwing inside the render loop.
      return null;
    }
  }

  dispose(): void {
    this.canvas = null;
    this.context = null;
  }
}
