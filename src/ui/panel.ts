import { FILL_ORDER, STYLE_ORDER, type Settings, type SettingsStore } from '../settings';

export interface PanelStats {
  displayFps: number;
  pipelineFps: number;
  detectMs: number;
  inferMs: number;
  maskMs: number;
  inpaintMs: number;
  phones: number;
  bestScore: number;
  objects: string[];
  rejected: string;
  held: boolean;
  detector: string;
  fill: string;
  source: string;
}

const FILL_LABELS = { migan: '1 · MI-GAN', telea: '2 · Telea (OpenCV)', stylised: '3 · Stylised' } as const;
const DETECTORS = ['yolo11s-seg', 'yolo11n-seg', 'yolo11s-seg-320', 'yolo11n-seg-320'] as const;
const DETECTOR_LABELS = {
  'yolo11s-seg': 'yolo11s · 640 (default)',
  'yolo11n-seg': 'yolo11n · 640',
  'yolo11s-seg-320': 'yolo11s · 320 (lighter)',
  'yolo11n-seg-320': 'yolo11n · 320 (lightest)',
} as const;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** A tablet or phone, where there may be no keyboard. iPadOS reports itself as a Mac, so ask for touch. */
export const isTouchDevice = navigator.maxTouchPoints > 0;

/** The debug panel (toggled with D, or a double-tap on a touch screen). Plain DOM, no framework. */
export class DebugPanel {
  readonly root = el('div', 'panel hidden');
  private actions = el('div', 'actions');
  private stats = el('pre', 'stats');
  private syncers: (() => void)[] = [];

  constructor(private store: SettingsStore) {
    this.root.append(el('div', 'panel-title', 'Device Remover · debug'), this.actions, this.stats);

    this.select('fill', 'Fill mode', FILL_ORDER, (v) => FILL_LABELS[v]);
    this.select('style', 'Stylised variant', STYLE_ORDER, (v) => v);
    this.slider('confidence', 'Confidence threshold', 0.05, 0.9, 0.01, (v) => v.toFixed(2));
    this.checkbox('topClassOnly', 'Phone must be the top category');
    this.slider('watchMs', 'Watch a new object for', 0, 6000, 500, (v) => (v ? `${(v / 1000).toFixed(1)} s` : 'no wait'));
    this.slider('watchShare', 'Erase if phone in at least', 0.3, 1, 0.01, (v) => `${Math.round(v * 100)} % of frames`);
    this.slider('dilate', 'Mask dilation', 0, 40, 1, (v) => `${v} px`);
    this.slider('feather', 'Edge feather', 0, 30, 1, (v) => `${v} px`);
    this.slider('holdFrames', 'Hold frames on dropout', 0, 30, 1, (v) => `${v}`);
    this.slider('persistMs', 'Mask persistence', 0, 600, 10, (v) => `${v} ms`);
    this.slider('cropSize', 'Inpaint crop size', 128, 480, 16, (v) => `${v} px`);
    this.slider('fillSmoothing', 'Fill temporal smoothing', 0, 0.8, 0.05, (v) => v.toFixed(2));
    this.checkbox('showMask', 'Mask overlay (M)');
    this.checkbox('mirror', 'Mirror (X)');
    this.checkbox('cover', 'Fill screen (crop edges)');
    this.checkbox('syncDisplay', 'Sync display to fill (no ghosting, more lag)');
    this.select('detector', 'Detector model (reloads)', DETECTORS, (v) => DETECTOR_LABELS[v]);
    this.select('camera', 'Camera (reloads)', ['front', 'back'] as const, (v) => v);

    const reset = el('button', 'btn', 'Reset to defaults');
    reset.onclick = () => store.reset();
    this.root.append(
      reset,
      el(
        'div',
        'keys',
        isTouchDevice
          ? 'Double-tap the picture to show or hide this panel.'
          : 'D panel · 1/2/3 fill (3 again: next style) · M mask · X mirror · S snapshot · F fullscreen',
      ),
    );

    store.onChange(() => this.syncers.forEach((s) => s()));
  }

  /** Buttons at the top of the panel, for what is otherwise only on the keyboard. */
  addAction(label: string, run: () => void): void {
    const b = el('button', 'btn', label);
    b.onclick = run;
    this.actions.append(b);
  }

  toggle(): void {
    this.root.classList.toggle('hidden');
  }

  get visible(): boolean {
    return !this.root.classList.contains('hidden');
  }

  setStats(s: PanelStats): void {
    const ms = (v: number) => (v ? `${v.toFixed(1).padStart(5)} ms` : '    – ms');
    this.stats.textContent = [
      `display   ${s.displayFps.toFixed(0).padStart(3)} fps`,
      `fill      ${s.pipelineFps.toFixed(1).padStart(5)} fps`,
      `detect   ${ms(s.detectMs)}  (model ${s.inferMs.toFixed(1)})`,
      `mask     ${ms(s.maskMs)}`,
      `inpaint  ${ms(s.inpaintMs)}`,
      `erased    ${s.phones}${s.phones ? `  score ${s.bestScore.toFixed(2)}` : ''}${s.held ? '  (holding)' : ''}`,
      // One line per object followed: state and the share of its recent frames that said phone.
      ...(s.objects.length ? s.objects : ['–']).map((line, i) => `${i ? '          ' : 'objects   '}${line}`),
      `not phone ${s.rejected || '–'}`,
      `detector  ${s.detector}`,
      `fill      ${s.fill}`,
      `source    ${s.source}`,
    ].join('\n');
  }

  private row(label: string): { row: HTMLLabelElement; value: HTMLSpanElement } {
    const row = el('label', 'row');
    const value = el('span', 'value');
    const head = el('div', 'row-head');
    head.append(el('span', undefined, label), value);
    row.append(head);
    this.root.append(row);
    return { row, value };
  }

  private slider<K extends NumericKey>(key: K, label: string, min: number, max: number, step: number, fmt: (v: number) => string): void {
    const { row, value } = this.row(label);
    const input = el('input');
    input.type = 'range';
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.oninput = () => this.store.set(key, Number(input.value));
    row.append(input);
    const sync = () => {
      input.value = String(this.store.value[key]);
      value.textContent = fmt(this.store.value[key]);
    };
    this.syncers.push(sync);
    sync();
  }

  private checkbox<K extends BooleanKey>(key: K, label: string): void {
    const row = el('label', 'row check');
    const input = el('input');
    input.type = 'checkbox';
    input.onchange = () => this.store.set(key, input.checked);
    row.append(input, el('span', undefined, label));
    this.root.append(row);
    const sync = () => {
      input.checked = this.store.value[key];
    };
    this.syncers.push(sync);
    sync();
  }

  private select<K extends StringKey>(key: K, label: string, options: readonly Settings[K][], fmt: (v: Settings[K]) => string): void {
    const { row } = this.row(label);
    const input = el('select');
    for (const o of options) {
      const opt = el('option', undefined, fmt(o));
      opt.value = o;
      input.append(opt);
    }
    input.onchange = () => this.store.set(key, input.value as Settings[K]);
    row.append(input);
    const sync = () => {
      input.value = this.store.value[key];
    };
    this.syncers.push(sync);
    sync();
  }
}

type KeysOfType<T> = { [K in keyof Settings]: Settings[K] extends T ? K : never }[keyof Settings];
type NumericKey = KeysOfType<number>;
type BooleanKey = KeysOfType<boolean>;
type StringKey = KeysOfType<string>;
