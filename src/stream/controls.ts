/**
 * The iPad's controls on top of the picture, laid out like a camera app and made for holding the
 * iPad with both hands: everything is in reach of the right thumb.
 *
 *   ⟳         front / back camera
 *   ◯         tap: screenshot · hold: start recording (it goes on after letting go) · tap: stop
 *   REMOVE
 *   (GROW)    the mode: swipe up or down anywhere on the right side, or tap a name
 *   HIJACK
 *
 * Each finger is followed on its own, through pointer events. A browser's "click" only comes from
 * the first finger on the screen, and while the left thumb rests on the glass that is the wrong one.
 */
import type { ModeId } from '../settings';
import { IPAD_MODES, type IpadMode } from './modeLink';

/** Holding the shutter this long (ms) starts a recording. */
const HOLD_MS = 450;
/** A finger that moves this far (px) is swiping, not pressing. */
const MOVE = 12;
/** Thumb travel (px) that moves the slider by one mode. One swipe never moves it by more. */
const STEP = 84;
/** A swipe counts from this share of STEP on, or from this speed (px/ms). */
const ENOUGH = 0.4;
const FLICK = 0.35;
/** The Mac has not followed a swipe for this long (ms): show what it really does. */
const CONFIRM_MS = 2500;
/** How wide the side is on which a swipe changes the mode (px, and at most this share of the screen). */
const SIDE = 420;
const SIDE_SHARE = 0.36;

export interface ControlActions {
  screenshot(): void;
  startRecording(): void;
  stopRecording(): void;
  recording(): boolean;
  flip(): void;
  /** Ask the Mac for a mode; false if there is no connection to it. */
  mode(mode: IpadMode): boolean;
}

const LABELS: Record<IpadMode, string> = { remove: 'Remove', grow: 'Grow', hijack: 'Hijack' };

const FLIP_ICON = `<svg viewBox="0 0 28 28" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
  <path d="M5.2 12.4A9 9 0 0 1 21.6 9.2"/><path d="M22.8 15.6A9 9 0 0 1 6.4 18.8"/>
  <path d="M22.4 5.2 21.8 9.6 17.5 9"/><path d="M5.6 22.8 6.2 18.4 10.5 19"/></svg>`;

/** A finger on the controls' side of the screen. */
interface Finger {
  id: number;
  x: number;
  y: number;
  /** Where the swipe started (after the first MOVE px). */
  from: number;
  lastY: number;
  lastT: number;
  speed: number;
  swiping: boolean;
  /** The button it went down on. */
  button: HTMLButtonElement | null;
  /** Its press has had its effect already (a recording started): lifting it does nothing more. */
  done: boolean;
}

export class Controls {
  readonly root = document.createElement('div');
  /** Recording time, at the top like in a camera app. */
  readonly timer = document.createElement('div');

  private readonly flipButton: HTMLButtonElement;
  private readonly shutter: HTMLButtonElement;
  private readonly dial = document.createElement('div');
  private readonly names: HTMLButtonElement[];
  private fingers = new Map<number, Finger>();
  private swiper: Finger | null = null;
  private holdTimer: ReturnType<typeof setTimeout> | undefined;
  /** Running while the Mac has not answered to what was asked for. */
  private confirmTimer: ReturnType<typeof setTimeout> | undefined;
  /** What the Mac says it is doing. */
  private actual: ModeId | null = null;
  private index = 0;
  private spins = 0;

  constructor(private readonly do_: ControlActions) {
    this.root.className = 'cam';
    this.flipButton = this.button('cam-flip', 'Switch between front and back camera', FLIP_ICON);
    this.shutter = this.button(
      'cam-shutter',
      'Screenshot. Hold to record.',
      '<svg viewBox="0 0 84 84" aria-hidden="true"><circle class="rim" cx="42" cy="42" r="39"/><circle class="hold" cx="42" cy="42" r="39"/></svg><i></i>',
    );
    this.dial.className = 'cam-dial';
    this.dial.setAttribute('role', 'radiogroup');
    this.dial.setAttribute('aria-label', 'Mode');
    const pill = document.createElement('div');
    pill.className = 'pill';
    const list = document.createElement('div');
    list.className = 'list';
    this.names = IPAD_MODES.map((mode) => {
      const b = this.button('', LABELS[mode], LABELS[mode]);
      b.dataset.mode = mode;
      b.setAttribute('role', 'radio');
      list.append(b);
      return b;
    });
    this.dial.append(pill, list);
    this.root.append(this.flipButton, this.shutter, this.dial);
    this.timer.className = 'cam-timer hidden';
    this.settle();

    document.addEventListener('pointerdown', (e) => this.down(e));
    document.addEventListener('pointermove', (e) => this.move(e));
    document.addEventListener('pointerup', (e) => this.up(e));
    document.addEventListener('pointercancel', (e) => this.cancel(e));
    // Keyboard and VoiceOver: a click without a finger behind it.
    this.root.addEventListener('click', (e) => {
      const b = e.target instanceof Element ? e.target.closest('button') : null;
      if (b && e.detail === 0) this.press(b);
    });
    this.root.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  /** The mode the slider is on: what was asked for, even if the Mac has not answered yet. */
  get wanted(): IpadMode {
    return IPAD_MODES[this.index];
  }

  /** What the Mac says it is doing; null while there is no connection to it. */
  setMode(mode: ModeId | null): void {
    this.actual = mode;
    this.dial.classList.toggle('offline', mode === null);
    if (mode === null) return;
    if (mode === this.wanted) this.confirmed();
    // Two quick swipes: the answer to the first one must not pull the slider back.
    if (!this.swiper && !this.confirmTimer) this.showActual();
  }

  setRecording(on: boolean, time: string): void {
    this.shutter.classList.toggle('recording', on);
    this.shutter.setAttribute('aria-label', on ? 'Stop recording' : 'Screenshot. Hold to record.');
    this.timer.classList.toggle('hidden', !on);
    this.timer.textContent = time;
    document.body.classList.toggle('recording', on);
  }

  /** Whether this touch is on the controls (and so not a tap on the picture). */
  owns(e: PointerEvent): boolean {
    return e.target instanceof Element && !!e.target.closest('.cam');
  }

  private button(className: string, label: string, html: string): HTMLButtonElement {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = className;
    b.setAttribute('aria-label', label);
    b.innerHTML = html;
    return b;
  }

  // ------------------------------------------------------------------ fingers

  private down(e: PointerEvent): void {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const target = e.target instanceof Element ? e.target : null;
    if (!target || target.closest('.panel, .save-shot')) return;
    const button = target.closest<HTMLButtonElement>('.cam button');
    if (!button && e.clientX < innerWidth - Math.min(SIDE, innerWidth * SIDE_SHARE)) return;
    this.fingers.set(e.pointerId, { id: e.pointerId, x: e.clientX, y: e.clientY, from: e.clientY, lastY: e.clientY, lastT: e.timeStamp, speed: 0, swiping: false, button, done: false });
    if (!button) return;
    button.classList.add('pressing');
    if (button !== this.shutter || this.do_.recording()) return;
    clearTimeout(this.holdTimer);
    const finger = this.fingers.get(e.pointerId)!;
    this.holdTimer = setTimeout(() => {
      finger.done = true;
      this.do_.startRecording();
    }, HOLD_MS);
  }

  private move(e: PointerEvent): void {
    const f = this.fingers.get(e.pointerId);
    if (!f || f.done) return;
    const dx = e.clientX - f.x;
    const dy = e.clientY - f.y;
    if (!f.swiping) {
      if (Math.hypot(dx, dy) < MOVE) return;
      // No longer a press. Along the slider: a swipe (one finger at a time).
      this.letGo(f);
      f.button = null;
      if (Math.abs(dy) < Math.abs(dx) || this.swiper) {
        if (Math.hypot(dx, dy) > 3 * MOVE) this.fingers.delete(f.id);
        return;
      }
      f.swiping = true;
      f.from = e.clientY;
      this.swiper = f;
      this.dial.classList.add('dragging');
    }
    const dt = e.timeStamp - f.lastT;
    if (dt > 0) f.speed = 0.6 * f.speed + 0.4 * ((e.clientY - f.lastY) / dt);
    f.lastY = e.clientY;
    f.lastT = e.timeStamp;
    this.show(this.index + this.travel(f));
  }

  private up(e: PointerEvent): void {
    const f = this.fingers.get(e.pointerId);
    if (!f) return;
    this.fingers.delete(e.pointerId);
    this.letGo(f);
    if (f.swiping) {
      this.swiper = null;
      this.dial.classList.remove('dragging');
      // A finger that stood still before lifting is not flicking.
      const speed = e.timeStamp - f.lastT > 80 ? 0 : f.speed;
      const way = this.travel(f);
      const step = Math.abs(way) >= ENOUGH || (Math.abs(speed) > FLICK && Math.sign(speed) !== Math.sign(way)) ? Math.sign(way) : 0;
      this.choose(this.index + step);
      return;
    }
    if (!f.button || f.done) return;
    // Lifted on the same button (a thumb is wide: a little outside still counts).
    const r = f.button.getBoundingClientRect();
    if (e.clientX > r.left - 24 && e.clientX < r.right + 24 && e.clientY > r.top - 24 && e.clientY < r.bottom + 24) this.press(f.button);
  }

  private cancel(e: PointerEvent): void {
    const f = this.fingers.get(e.pointerId);
    if (!f) return;
    this.fingers.delete(e.pointerId);
    this.letGo(f);
    if (!f.swiping) return;
    this.swiper = null;
    this.dial.classList.remove('dragging');
    this.settle();
  }

  private letGo(f: Finger): void {
    f.button?.classList.remove('pressing');
    if (f.button === this.shutter && !f.done) clearTimeout(this.holdTimer);
  }

  private press(b: HTMLButtonElement): void {
    if (b === this.shutter) {
      if (this.do_.recording()) this.do_.stopRecording();
      else this.do_.screenshot();
    } else if (b === this.flipButton) {
      b.style.setProperty('--turn', `${++this.spins * 180}deg`);
      this.do_.flip();
    } else {
      const i = this.names.indexOf(b);
      if (i >= 0) this.choose(i);
    }
  }

  // ------------------------------------------------------------------ the mode slider

  /** How far a swipe has moved the slider, in modes: at most one, and hardly any past its ends. */
  private travel(f: Finger): number {
    const way = Math.max(-1, Math.min(1, (f.from - f.lastY) / STEP));
    const to = this.index + way;
    return to < 0 || to > IPAD_MODES.length - 1 ? way * 0.22 : way;
  }

  private choose(i: number): void {
    const next = Math.max(0, Math.min(IPAD_MODES.length - 1, i));
    const before = this.index;
    this.index = next;
    this.settle();
    if (next === before && this.actual === this.wanted) return;
    this.confirmed();
    if (!this.do_.mode(this.wanted)) {
      // No connection to the Mac: back to where it was.
      this.index = before;
      this.showActual();
      return;
    }
    this.confirmTimer = setTimeout(() => {
      this.confirmed();
      this.showActual();
    }, CONFIRM_MS);
  }

  private confirmed(): void {
    clearTimeout(this.confirmTimer);
    this.confirmTimer = undefined;
  }

  private showActual(): void {
    const i = IPAD_MODES.findIndex((m) => m === this.actual);
    if (i >= 0) this.index = i;
    this.settle();
  }

  private settle(): void {
    this.show(this.index);
  }

  private show(position: number): void {
    this.dial.style.setProperty('--at', position.toFixed(3));
    const nearest = Math.max(0, Math.min(IPAD_MODES.length - 1, Math.round(position)));
    this.names.forEach((b, i) => b.setAttribute('aria-checked', String(i === nearest)));
  }
}
