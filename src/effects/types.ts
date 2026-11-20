import type { PhoneBox } from '../detect/yoloSeg';
import type { StableMask } from '../mask/stabilizer';
import type { Settings } from '../settings';

/** A phone the effect applies to: the tracker has decided on it. */
export interface PickedPhone extends PhoneBox {
  /** The tracker's id: the same object keeps it from frame to frame. */
  id: number;
  /** ms since the tracker decided on it. */
  erasedMs: number;
}

/** Everything an effect gets to know about one processed camera frame. */
export interface EffectFrame {
  /** The camera frame the detection was made on. */
  frame: HTMLCanvasElement;
  width: number;
  height: number;
  mask: StableMask;
  /** Frame-sized canvas whose alpha channel is the feathered mask. */
  maskCanvas: HTMLCanvasElement;
  /**
   * This frame's own detector mask of the picked phones with anti-aliased edges (0..255, edge at
   * 128), with no persistence, hold or feather. Only for effects with `needsPhoneAlpha`; null
   * otherwise, or when no phone was found. Reused by the detector: only valid during this frame.
   */
  phoneAlpha: Uint8Array | null;
  /**
   * The people next to the phones (anti-aliased, 0..255), only inside each phone's reach area.
   * Only for effects whose `needsPersonAlpha` says so; null otherwise. Valid during this frame only.
   */
  personAlpha: Uint8Array | null;
  /** The phones the effect applies to in this frame. */
  phones: PickedPhone[];
  settings: Settings;
}

/**
 * An effect is what happens to a detected phone: "remove" (erase and fill) or "grow" (cut it
 * out and draw it bigger). Effects are swapped at the Pipeline, reusing camera, detection and
 * mask stabilisation unchanged.
 *
 * Two clocks: `onMask`/`process` run on the (slower) detection loop, `render` runs on every
 * display frame and must be cheap.
 */
export interface Effect {
  readonly id: string;
  /** Ask the detector for `phoneAlpha` (costs a little time per frame). */
  readonly needsPhoneAlpha?: boolean;
  /** Ask the detector for `personAlpha` with these settings (costs a little time per frame). */
  needsPersonAlpha?(s: Settings): boolean;
  /** One-line description of what is active, for the debug panel (e.g. "MI-GAN · webgpu"). */
  describe(): string;
  /** Called as soon as the mask for a new frame is known. Cheap, synchronous. */
  onMask(f: EffectFrame): void;
  /** Heavy per-frame work (e.g. inpainting). Resolves when its result is ready to be rendered. */
  process(f: EffectFrame): Promise<void>;
  /**
   * Draw on top of the camera image that is already in `ctx`. With `still` set, draw the
   * current result at full strength with no animation (used for snapshots).
   */
  render(ctx: CanvasRenderingContext2D, still?: boolean): void;
  /** Forget everything: called when the effect is switched in, so nothing stale is shown. */
  reset(): void;
  /** Called when another effect is switched in (e.g. to stop a sound). */
  deactivate?(): void;
  /** How long the tracker watches a new phone before deciding, if not `settings.watchMs`. */
  watchMs?(s: Settings): number;
}
