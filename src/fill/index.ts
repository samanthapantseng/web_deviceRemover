import type { FillId } from '../settings';
import { MiganFill } from './migan';
import { StylisedFill } from './stylised';
import { TeleaFill } from './telea';
import type { Fill } from './types';

export type FillState = 'idle' | 'loading' | 'ready' | 'failed';

/**
 * The selectable fills and their load state. To add a fill: implement `Fill`, register it here.
 *
 * A fill is only loaded when it is first wanted. MI-GAN and OpenCV.js together take a lot of
 * memory, enough to get the page killed on an iPad, so the live view keeps only the one in use
 * (plus the stylised one, which is tiny and the stand-in while another loads).
 */
export class FillSet {
  private fills: Record<FillId, Fill> = {
    migan: new MiganFill(),
    telea: new TeleaFill(),
    stylised: new StylisedFill(),
  };
  private states: Record<FillId, FillState> = { migan: 'idle', telea: 'idle', stylised: 'idle' };
  private loads: Partial<Record<FillId, Promise<void>>> = {};
  private errors: Partial<Record<FillId, string>> = {};

  /** Starts loading a fill unless it is loaded or loading. Never rejects: a fill that fails is marked 'failed'. */
  ensure(id: FillId): Promise<void> {
    this.loads[id] ??= (async () => {
      this.states[id] = 'loading';
      try {
        await this.fills[id].init();
        this.states[id] = 'ready';
      } catch (err) {
        this.states[id] = 'failed';
        this.errors[id] = err instanceof Error ? err.message : String(err);
        console.error(`[fill] ${id} failed to load`, err);
      }
    })();
    return this.loads[id];
  }

  /** Loads every fill (the still-image test page compares them all). */
  async load(): Promise<void> {
    await this.ensure('stylised');
    await Promise.all([this.ensure('telea'), this.ensure('migan')]);
  }

  get(id: FillId): Fill {
    return this.fills[id];
  }

  state(id: FillId): FillState {
    return this.states[id];
  }

  error(id: FillId): string | undefined {
    return this.errors[id];
  }

  /** The wanted fill if it is ready, otherwise the stylised one (which cannot fail) while it loads. */
  resolve(wanted: FillId): Fill {
    if (this.states[wanted] === 'ready') return this.fills[wanted];
    void this.ensure(wanted);
    return this.fills.stylised;
  }
}
