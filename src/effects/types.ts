import type { PhoneBox } from '../detect/yoloSeg';
import type { StableMask } from '../mask/stabilizer';
import type { Settings } from '../settings';

/** Everything an effect gets to know about one processed camera frame. */
export interface EffectFrame {
  /** The camera frame the detection was made on. */
  frame: HTMLCanvasElement;
  width: number;
  height: number;
  mask: StableMask;
  /** Frame-sized canvas whose alpha channel is the feathered mask. */
  maskCanvas: HTMLCanvasElement;
  boxes: PhoneBox[];
  settings: Settings;
}

/**
 * An effect is what happens to a detected phone. "Remove" (erase and fill) is the only one
 * for now; later modes (the phone inflating, etc.) implement this same interface and are
 * swapped in at the Pipeline, reusing camera, detection and mask stabilisation unchanged.
 *
 * Two clocks: `onMask`/`process` run on the (slower) detection loop, `render` runs on every
 * display frame and must be cheap.
 */
export interface Effect {
  readonly id: string;
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
}
