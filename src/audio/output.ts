import type { SceneId } from '../settings';
import type { VoiceParams } from './conversation';

/**
 * Where hijack mode's sound goes: this page's own speakers or headphones (LiveSound, engine.ts),
 * or the iPad (RemoteSound, stream/soundLink.ts). The effect decides who is in focus and does
 * not care which of the two it is.
 */
export interface SoundOutput {
  /** Called for every processed frame in hijack mode: get ready to sound, if possible. */
  ensure(): void;
  setVolume(v: number): void;
  /** The key of the conversation in focus ('' when silent). */
  readonly focusKey: string;
  /** Listen to someone (see SoundEngine.focus). */
  focus(key: string, scene: SceneId, seed: number, p: VoiceParams, elapsed: number): void;
  /** New numbers for the conversation in focus. */
  update(p: VoiceParams): void;
  /** Back to silence. */
  release(): void;
  /** For the panel: what it is doing, or what is missing. */
  status(): string;
}
