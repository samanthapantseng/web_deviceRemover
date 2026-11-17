import type { FillId } from '../settings';
import { MiganFill } from './migan';
import { StylisedFill } from './stylised';
import { TeleaFill } from './telea';
import type { Fill } from './types';

export type FillState = 'loading' | 'ready' | 'failed';

/** The selectable fills and their load state. To add a fill: implement `Fill`, register it here. */
export class FillSet {
  private fills: Record<FillId, Fill> = {
    migan: new MiganFill(),
    telea: new TeleaFill(),
    stylised: new StylisedFill(),
  };
  private states: Record<FillId, FillState> = { migan: 'loading', telea: 'loading', stylised: 'loading' };
  private errors: Partial<Record<FillId, string>> = {};

  /** Loads every fill. Never rejects: a fill that fails is marked 'failed' and skipped. */
  async load(onChange?: () => void): Promise<void> {
    const load = async (id: FillId) => {
      try {
        await this.fills[id].init();
        this.states[id] = 'ready';
      } catch (err) {
        this.states[id] = 'failed';
        this.errors[id] = err instanceof Error ? err.message : String(err);
        console.error(`[fill] ${id} failed to load`, err);
      }
      onChange?.();
    };
    await load('stylised'); // instant, and the fallback for the other two
    await Promise.all([load('telea'), load('migan')]);
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

  /** The wanted fill if it is ready, otherwise the stylised one (which cannot fail). */
  resolve(wanted: FillId): Fill {
    return this.states[wanted] === 'ready' ? this.fills[wanted] : this.fills.stylised;
  }
}
