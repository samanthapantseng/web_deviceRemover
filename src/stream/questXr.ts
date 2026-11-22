/**
 * Quest 3, the immersive view ("room view"): the room is the headset's own passthrough, with no
 * delay; on top of it, only what covers the phones, from the Mac (patches.ts).
 *
 * Each patch belongs to one camera frame (its counter, latency.ts). This page remembers where
 * the head was over the last seconds, so a patch is put where the camera was looking when that
 * frame was taken, and stays there in the room while the head moves on. Only the patch is late
 * (by the round trip to the Mac), never the room.
 *
 * Where exactly the camera looks is not published for web pages, so it is set by hand and kept
 * on this Quest: the camera's field of view, which of the two front cameras it is, a small tilt,
 * how far away the patch is drawn, and how long the camera takes to deliver a frame. What the
 * lining-up leaves (and the delay) is covered by a blurred border around each patch ("extra
 * cover", in cm at the set distance; made on the Mac, patches.ts). Lining up
 * (README, "Meta Quest 3"): the whole camera frame is drawn half-transparent over the room
 * (B), and the values are changed (A, then the thumbstick) until the two match.
 *
 * Controllers: A or X  settings on / off · B or Y  whole frame on / off
 *              thumbstick up / down  choose a setting · left / right  change it
 */
import { report } from '../devReport';
import type { Patch } from './patches';

// ---------------------------------------------------------------- WebXR (not in TypeScript's DOM types)

interface XrRigidTransform {
  readonly position: DOMPointReadOnly;
  readonly orientation: DOMPointReadOnly;
  readonly matrix: Float32Array;
  readonly inverse: XrRigidTransform;
}
interface XrView {
  readonly projectionMatrix: Float32Array;
  readonly transform: XrRigidTransform;
}
interface XrViewerPose {
  readonly transform: XrRigidTransform;
  readonly views: readonly XrView[];
}
interface XrFrame {
  getViewerPose(space: XrReferenceSpace): XrViewerPose | null;
}
type XrReferenceSpace = EventTarget;
interface XrInputSource {
  readonly handedness: 'left' | 'right' | 'none';
  readonly gamepad?: Gamepad;
}
interface XrWebGLLayer {
  readonly framebuffer: WebGLFramebuffer | null;
  getViewport(view: XrView): { x: number; y: number; width: number; height: number } | null;
}
interface XrSession extends EventTarget {
  readonly inputSources: ArrayLike<XrInputSource>;
  readonly visibilityState?: string;
  readonly environmentBlendMode?: string;
  readonly frameRate?: number;
  requestReferenceSpace(type: string): Promise<XrReferenceSpace>;
  updateRenderState(state: { baseLayer?: XrWebGLLayer; depthNear?: number; depthFar?: number }): void;
  requestAnimationFrame(cb: (t: number, frame: XrFrame) => void): number;
  end(): Promise<void>;
}
interface XrSystem {
  isSessionSupported(mode: string): Promise<boolean>;
  requestSession(mode: string, init?: { requiredFeatures?: string[]; optionalFeatures?: string[] }): Promise<XrSession>;
}
type XrWebGLLayerCtor = new (session: XrSession, gl: WebGL2RenderingContext, init?: { alpha?: boolean; antialias?: boolean }) => XrWebGLLayer;

const xr = (navigator as Navigator & { xr?: XrSystem }).xr;

/** Whether this browser can show the room view (immersive-ar: passthrough). */
export async function roomViewSupported(): Promise<boolean> {
  try {
    return !!xr && (await xr.isSessionSupported('immersive-ar'));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- small 3D math (column-major, like WebXR)

type Vec3 = [number, number, number];
type Quat = [number, number, number, number];

function multiply(a: Float32Array, b: Float32Array): Float32Array {
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
      o[c * 4 + r] = s;
    }
  }
  return o;
}

function fromPose(p: ArrayLike<number>, q: ArrayLike<number>): Float32Array {
  const [x, y, z, w] = [q[0], q[1], q[2], q[3]];
  const m = new Float32Array(16);
  m[0] = 1 - 2 * (y * y + z * z);
  m[1] = 2 * (x * y + w * z);
  m[2] = 2 * (x * z - w * y);
  m[4] = 2 * (x * y - w * z);
  m[5] = 1 - 2 * (x * x + z * z);
  m[6] = 2 * (y * z + w * x);
  m[8] = 2 * (x * z + w * y);
  m[9] = 2 * (y * z - w * x);
  m[10] = 1 - 2 * (x * x + y * y);
  m[12] = p[0];
  m[13] = p[1];
  m[14] = p[2];
  m[15] = 1;
  return m;
}

const rad = (deg: number) => (deg * Math.PI) / 180;

function translation(x: number, y: number, z: number): Float32Array {
  const m = fromPose([x, y, z], [0, 0, 0, 1]);
  return m;
}

/** Rotation about x (tilt up / down) then y (turn left / right), degrees. */
function tilt(pitchDeg: number, yawDeg: number): Float32Array {
  const p = rad(pitchDeg) / 2;
  const y = rad(yawDeg) / 2;
  const qx: Quat = [Math.sin(p), 0, 0, Math.cos(p)];
  const qy: Quat = [0, Math.sin(y), 0, Math.cos(y)];
  return multiply(fromPose([0, 0, 0], qy), fromPose([0, 0, 0], qx));
}

function apply(m: Float32Array, v: Vec3): Vec3 {
  return [
    m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12],
    m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13],
    m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14],
  ];
}

function slerp(a: Quat, b: Quat, t: number): Quat {
  let [bx, by, bz, bw] = b;
  let dot = a[0] * bx + a[1] * by + a[2] * bz + a[3] * bw;
  if (dot < 0) {
    dot = -dot;
    bx = -bx;
    by = -by;
    bz = -bz;
    bw = -bw;
  }
  let s0 = 1 - t;
  let s1 = t;
  if (dot < 0.9995) {
    const th = Math.acos(dot);
    const sin = Math.sin(th);
    s0 = Math.sin((1 - t) * th) / sin;
    s1 = Math.sin(t * th) / sin;
  }
  const q: Quat = [s0 * a[0] + s1 * bx, s0 * a[1] + s1 * by, s0 * a[2] + s1 * bz, s0 * a[3] + s1 * bw];
  const n = Math.hypot(...q) || 1;
  return [q[0] / n, q[1] / n, q[2] / n, q[3] / n];
}

/** Where the head was over the last few seconds, to look up the moment a camera frame was taken. */
class PoseHistory {
  private static readonly N = 512;
  private t = new Float64Array(PoseHistory.N);
  private p = new Float32Array(PoseHistory.N * 3);
  private q = new Float32Array(PoseHistory.N * 4);
  private count = 0;
  private next = 0;

  push(t: number, p: DOMPointReadOnly, q: DOMPointReadOnly): void {
    const i = this.next;
    this.t[i] = t;
    this.p.set([p.x, p.y, p.z], i * 3);
    this.q.set([q.x, q.y, q.z, q.w], i * 4);
    this.next = (i + 1) % PoseHistory.N;
    this.count = Math.min(this.count + 1, PoseHistory.N);
  }

  /** The head's pose at time `t` (interpolated), as a matrix; null if `t` is not covered. */
  at(t: number): Float32Array | null {
    const N = PoseHistory.N;
    if (!this.count) return null;
    const newest = (this.next - 1 + N) % N;
    if (t >= this.t[newest]) return this.matrix(newest, newest, 0);
    for (let k = 1; k < this.count; k++) {
      const i = (newest - k + N) % N;
      if (this.t[i] <= t) {
        const j = (i + 1) % N;
        const f = (t - this.t[i]) / Math.max(1e-3, this.t[j] - this.t[i]);
        return this.matrix(i, j, f);
      }
    }
    return null; // older than the history
  }

  private matrix(i: number, j: number, f: number): Float32Array {
    const p = [0, 1, 2].map((k) => this.p[i * 3 + k] * (1 - f) + this.p[j * 3 + k] * f);
    const qa = [0, 1, 2, 3].map((k) => this.q[i * 4 + k]) as Quat;
    const qb = [0, 1, 2, 3].map((k) => this.q[j * 4 + k]) as Quat;
    return fromPose(p, slerp(qa, qb, f));
  }
}

// ---------------------------------------------------------------- settings (kept on this Quest)

interface Calibration {
  /** Horizontal field of view of the frame the Mac gets, degrees. */
  fov: number;
  /** How far away the patch is drawn, m. */
  distance: number;
  /** Camera delay: from taking a frame to the page getting it, ms. */
  delayMs: number;
  /** Which front camera the page uses. */
  side: 'left' | 'right';
  /** Small corrections of where the camera looks, degrees. */
  pitch: number;
  yaw: number;
  /** Blurred border around each patch, cm at `distance`. */
  cover: number;
}

const DEFAULTS: Calibration = { fov: 80, distance: 1.8, delayMs: 45, side: 'left', pitch: 0, yaw: 0, cover: 8 };
const CALIB_KEY = 'device-remover.quest-calibration.v1';

interface Setting {
  key: keyof Calibration;
  label: string;
  step: number;
  min: number;
  max: number;
  show(c: Calibration): string;
}
const SETTINGS: Setting[] = [
  { key: 'fov', label: 'size (field of view)', step: 1, min: 40, max: 130, show: (c) => `${c.fov.toFixed(0)}°` },
  { key: 'distance', label: 'distance', step: 0.1, min: 0.3, max: 8, show: (c) => `${c.distance.toFixed(1)} m` },
  { key: 'delayMs', label: 'camera delay', step: 5, min: 0, max: 300, show: (c) => `${c.delayMs.toFixed(0)} ms` },
  { key: 'side', label: 'camera', step: 0, min: 0, max: 0, show: (c) => c.side },
  { key: 'pitch', label: 'up / down', step: 0.5, min: -20, max: 20, show: (c) => `${c.pitch.toFixed(1)}°` },
  { key: 'yaw', label: 'left / right', step: 0.5, min: -20, max: 20, show: (c) => `${c.yaw.toFixed(1)}°` },
  { key: 'cover', label: 'extra cover', step: 1, min: 0, max: 30, show: (c) => `${c.cover.toFixed(0)} cm` },
];

function loadCalibration(): Calibration {
  try {
    return { ...DEFAULTS, ...(JSON.parse(localStorage.getItem(CALIB_KEY) ?? '{}') as Partial<Calibration>) };
  } catch {
    return { ...DEFAULTS };
  }
}

// ---------------------------------------------------------------- drawing

const VS = `#version 300 es
in vec3 a_pos;
in vec2 a_uv;
uniform mat4 u_mvp;
out vec2 v_uv;
void main() {
  v_uv = a_uv;
  gl_Position = u_mvp * vec4(a_pos, 1.0);
}`;
const FS = `#version 300 es
precision mediump float;
in vec2 v_uv;
uniform sampler2D u_tex;
uniform float u_alpha;
out vec4 color;
void main() {
  color = texture(u_tex, v_uv) * u_alpha; // premultiplied
}`;

interface Shown {
  /** The head's pose when the camera frame was taken. */
  head: Float32Array;
  /** The camera frame's size, and the part of it the image covers. */
  w: number;
  h: number;
  x: number;
  y: number;
  cw: number;
  ch: number;
  full: boolean;
  /** When its frame was stamped (performance.now()), to drop older ones arriving late. */
  sent: number;
}

export interface QuestViewOptions {
  /** When the frame with this counter was stamped (performance.now()), 0 if unknown. */
  sentTime(id: number): number;
  /** Ask the Mac for whole frames (lining up) or patches. */
  setFull(full: boolean): void;
  /** The extra cover the Mac should add around each patch, frame pixels. */
  setMargin(px: number): void;
  /** Called on every frame of the room view (the page is being drawn). */
  onRender(): void;
  /** The room view ended (Meta button, headset off for long, error). */
  onEnd(): void;
}

/** The room view. One per page; enter() starts it from a click. */
export class QuestView {
  private session: XrSession | null = null;
  private space: XrReferenceSpace | null = null;
  private gl: WebGL2RenderingContext | null = null;
  private layer: XrWebGLLayer | null = null;
  private program: WebGLProgram | null = null;
  private buffer: WebGLBuffer | null = null;
  private loc = { pos: 0, uv: 0, mvp: null as WebGLUniformLocation | null, alpha: null as WebGLUniformLocation | null };
  private patchTex: WebGLTexture | null = null;
  private hudTex: WebGLTexture | null = null;
  private hud = document.createElement('canvas');
  private hudCtx = this.hud.getContext('2d')!;
  private hudDirty = true;
  private hudDrawnAt = 0;

  private history = new PoseHistory();
  private calib = loadCalibration();
  private selected = 0;
  private settingsShown = false;
  private full = false;

  private shown: Shown | null = null;
  /** Width of the frames the Mac works on (from its patches). */
  private frameWidth = 640;
  private pending: (Shown & { bitmap: ImageBitmap }) | null = null;
  private newestSent = 0;
  private opacity = 0;
  private emptySince = 0;
  private lastPatchAt = 0;

  private buttons = new Map<string, boolean>();
  private stick: string | null = null;
  private stickRepeatAt = 0;

  /** For the panel, the HUD and the report. */
  readonly stats = { patches: 0, empty: 0, unplaced: 0, delays: [] as number[], fps: 0 };
  private frames = 0;
  private fpsSince = 0;
  private reportTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private opts: QuestViewOptions) {
    this.hud.width = 640;
    this.hud.height = 400;
  }

  get active(): boolean {
    return !!this.session;
  }

  /** Must be called from a click. */
  async enter(): Promise<void> {
    if (this.session || !xr) return;
    const session = await xr.requestSession('immersive-ar', { optionalFeatures: ['local'] });
    try {
      // Made for the headset the first time; a context from an earlier visit is made so again.
      const earlier = this.gl;
      const gl = earlier ?? this.makeGl();
      if (earlier) await (gl as WebGL2RenderingContext & { makeXRCompatible(): Promise<void> }).makeXRCompatible();
      const Layer = (globalThis as unknown as { XRWebGLLayer: XrWebGLLayerCtor }).XRWebGLLayer;
      this.layer = new Layer(session, gl, { alpha: true, antialias: false });
      session.updateRenderState({ baseLayer: this.layer, depthNear: 0.05, depthFar: 50 });
      this.space = await session.requestReferenceSpace('local');
    } catch (err) {
      await session.end().catch(() => undefined);
      throw err;
    }
    this.session = session;
    this.newestSent = 0;
    this.shown = null;
    this.opacity = 0;
    this.hudDirty = true;
    this.full = false;
    this.opts.setFull(false);
    this.sendMargin();
    session.addEventListener('end', () => {
      if (this.session !== session) return;
      this.session = null;
      this.pending?.bitmap.close();
      this.pending = null;
      report('status', { text: 'room view ended' });
      this.opts.onEnd();
    });
    session.addEventListener('visibilitychange', () => report('status', { text: `room view: ${session.visibilityState}` }));
    report('status', {
      text: `room view entered (${session.environmentBlendMode ?? '?'} blending, ${session.frameRate ?? '?'} Hz) · settings ${this.describeCalibration()}`,
    });
    session.requestAnimationFrame(this.onFrame);
  }

  exit(): void {
    void this.session?.end().catch(() => undefined);
  }

  /** A patch from the Mac (patches.ts). Ignored outside the room view. */
  onPatch(p: Patch): void {
    if (!this.session) return;
    this.lastPatchAt = p.receivedAt;
    const sent = p.id >= 0 ? this.opts.sentTime(p.id) : 0;
    if (!sent) {
      this.stats.unplaced++;
      return;
    }
    // Unordered channel: an older frame arriving after a newer one is dropped; so is the same
    // frame again (the Mac repeats its last frame while none come in, e.g. the headset is off).
    if (sent <= this.newestSent) return;
    this.newestSent = sent;
    if (p.w !== this.frameWidth) {
      this.frameWidth = p.w;
      this.sendMargin();
    }
    this.stats.delays.push(p.receivedAt - sent);
    if (this.stats.delays.length > 90) this.stats.delays.shift();
    if (p.kind === 'empty' || !p.image) {
      this.stats.empty++;
      if (!this.emptySince) this.emptySince = p.receivedAt;
      return;
    }
    this.stats.patches++;
    this.emptySince = 0;
    // Where the head was when the camera took this frame.
    const head = this.history.at(sent - this.calib.delayMs);
    if (!head) {
      this.stats.unplaced++;
      return;
    }
    const next = { head, w: p.w, h: p.h, x: p.x ?? 0, y: p.y ?? 0, cw: p.cw ?? p.w, ch: p.ch ?? p.h, full: p.kind === 'full', sent };
    void createImageBitmap(p.image, { premultiplyAlpha: 'premultiply', colorSpaceConversion: 'none' })
      .then((bitmap) => {
        // A newer one may have been decoded first.
        const newest = Math.max(this.pending?.sent ?? 0, this.shown?.sent ?? 0);
        if (!this.session || next.sent < newest) {
          bitmap.close();
          return;
        }
        this.pending?.bitmap.close();
        this.pending = { ...next, bitmap };
      })
      .catch(() => this.stats.unplaced++);
  }

  /** Median time from stamping a frame to its patch arriving, ms. */
  patchDelay(): number | null {
    const d = [...this.stats.delays].sort((a, b) => a - b);
    return d.length ? d[Math.floor(d.length / 2)] : null;
  }

  /** The extra cover in the Mac's frame pixels: cm at the set distance, through the field of view. */
  private sendMargin(): void {
    const c = this.calib;
    const fx = this.frameWidth / 2 / Math.tan(rad(c.fov) / 2);
    this.opts.setMargin(((c.cover / 100) * fx) / c.distance);
  }

  describeCalibration(): string {
    return SETTINGS.map((s) => `${s.label} ${s.show(this.calib)}`).join(', ');
  }

  // ---------------------------------------------------------------- frame loop

  private onFrame = (_t: number, frame: XrFrame): void => {
    const session = this.session;
    if (!session) return;
    session.requestAnimationFrame(this.onFrame);
    try {
      this.drawFrame(session, frame);
    } catch (err) {
      console.error('[quest] room view frame failed', err);
      report('status', { text: `room view frame failed: ${(err as Error).message}`, isError: true });
    }
  };

  private drawFrame(session: XrSession, frame: XrFrame): void {
    const now = performance.now();
    this.opts.onRender();
    const pose = this.space ? frame.getViewerPose(this.space) : null;
    if (!pose) return;
    this.history.push(now, pose.transform.position, pose.transform.orientation);
    this.countFps(now);
    this.pollControllers(session, now);

    const gl = this.gl!;
    const layer = this.layer!;
    if (this.pending) {
      const { bitmap, ...shown } = this.pending;
      this.pending = null;
      gl.bindTexture(gl.TEXTURE_2D, this.patchTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
      bitmap.close();
      this.shown = shown;
    }
    // Appear at once; fade out quickly when the Mac says nothing is to be covered, or when
    // nothing has come for a second (the Mac or the connection stopped).
    const gone = (this.emptySince && now - this.emptySince > 0) || now - this.lastPatchAt > 1000;
    this.opacity = gone ? Math.max(0, this.opacity - 1 / 10) : 1;
    if (this.settingsShown && (this.hudDirty || now - this.hudDrawnAt > 500)) this.drawHud(now);

    gl.bindFramebuffer(gl.FRAMEBUFFER, layer.framebuffer);
    gl.clearColor(0, 0, 0, 0); // transparent: the passthrough shows through
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(this.program);

    const shown = this.shown && this.opacity > 0 ? this.shown : null;
    const patchQuad = shown ? this.frameCorners(shown) : null;
    const hudQuad = this.settingsShown ? this.hudCorners(pose.transform.matrix) : null;
    for (const view of pose.views) {
      const vp = layer.getViewport(view);
      if (!vp) continue;
      gl.viewport(vp.x, vp.y, vp.width, vp.height);
      const mvp = multiply(view.projectionMatrix, view.transform.inverse.matrix);
      if (patchQuad) this.drawQuad(patchQuad, this.patchTex!, (shown!.full ? 0.5 : 1) * this.opacity, mvp);
      if (hudQuad) this.drawQuad(hudQuad, this.hudTex!, 1, mvp);
    }
  }

  /** The patch's corners in the room (its part of the camera frame), `distance` away, from where the camera was then. */
  private frameCorners(s: Shown): Vec3[] {
    const c = this.calib;
    // The camera, relative to the point between the eyes: about 3 cm to the side, a little
    // lower and in front (the front of the headset), turned by the small corrections.
    const cam = multiply(s.head, multiply(translation(c.side === 'left' ? -0.032 : 0.032, -0.015, -0.06), tilt(c.pitch, c.yaw)));
    const fx = s.w / 2 / Math.tan(rad(c.fov) / 2);
    const d = c.distance;
    const at = (u: number, v: number): Vec3 => apply(cam, [((u - s.w / 2) / fx) * d, (-(v - s.h / 2) / fx) * d, -d]);
    const [x0, y0, x1, y1] = [s.x, s.y, s.x + s.cw, s.y + s.ch];
    return [at(x0, y0), at(x0, y1), at(x1, y0), at(x1, y1)];
  }

  /** The settings panel: 65 cm in front, a little below the line of sight, moving with the head. */
  private hudCorners(head: Float32Array): Vec3[] {
    const w = 0.17;
    const h = (w * this.hud.height) / this.hud.width;
    const y = -0.1;
    const z = -0.65;
    return [apply(head, [-w, y + h, z]), apply(head, [-w, y - h, z]), apply(head, [w, y + h, z]), apply(head, [w, y - h, z])];
  }

  private drawQuad(corners: Vec3[], tex: WebGLTexture, alpha: number, mvp: Float32Array): void {
    const gl = this.gl!;
    const uv = [
      [0, 0],
      [0, 1],
      [1, 0],
      [1, 1],
    ];
    const data = new Float32Array(20);
    corners.forEach((p, i) => data.set([...p, ...uv[i]], i * 5));
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, data);
    gl.enableVertexAttribArray(this.loc.pos);
    gl.vertexAttribPointer(this.loc.pos, 3, gl.FLOAT, false, 20, 0);
    gl.enableVertexAttribArray(this.loc.uv);
    gl.vertexAttribPointer(this.loc.uv, 2, gl.FLOAT, false, 20, 12);
    gl.uniformMatrix4fv(this.loc.mvp, false, mvp);
    gl.uniform1f(this.loc.alpha, alpha);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  private makeGl(): WebGL2RenderingContext {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2', { xrCompatible: true, alpha: true, antialias: false } as WebGLContextAttributes);
    if (!gl) throw new Error('no WebGL2');
    const shader = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(`shader: ${gl.getShaderInfoLog(s)}`);
      return s;
    };
    const program = gl.createProgram()!;
    gl.attachShader(program, shader(gl.VERTEX_SHADER, VS));
    gl.attachShader(program, shader(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(`program: ${gl.getProgramInfoLog(program)}`);
    this.program = program;
    this.loc = {
      pos: gl.getAttribLocation(program, 'a_pos'),
      uv: gl.getAttribLocation(program, 'a_uv'),
      mvp: gl.getUniformLocation(program, 'u_mvp'),
      alpha: gl.getUniformLocation(program, 'u_alpha'),
    };
    this.buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, 20 * 4, gl.DYNAMIC_DRAW);
    const texture = () => {
      const t = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
      return t;
    };
    this.patchTex = texture();
    this.hudTex = texture();
    this.gl = gl;
    return gl;
  }

  // ---------------------------------------------------------------- settings panel and controllers

  private drawHud(now: number): void {
    const ctx = this.hudCtx;
    const { width: W, height: H } = this.hud;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = 'rgba(10, 10, 10, 0.82)';
    ctx.beginPath();
    ctx.roundRect(0, 0, W, H, 18);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.font = '600 26px system-ui, sans-serif';
    ctx.fillText('Device Remover · lining up', 24, 44);
    ctx.font = '22px system-ui, sans-serif';
    SETTINGS.forEach((s, i) => {
      const y = 92 + i * 38;
      const on = i === this.selected;
      if (on) {
        ctx.fillStyle = 'rgba(255, 255, 255, 0.16)';
        ctx.fillRect(14, y - 28, W - 28, 38);
      }
      ctx.fillStyle = on ? '#ffe600' : '#ddd';
      ctx.fillText(`${on ? '▶ ' : '   '}${s.label}`, 24, y);
      ctx.textAlign = 'right';
      ctx.fillText(s.show(this.calib), W - 28, y);
      ctx.textAlign = 'left';
    });
    const delay = this.patchDelay();
    ctx.fillStyle = '#9e9e9e';
    ctx.font = '19px system-ui, sans-serif';
    ctx.fillText(
      `whole frame ${this.full ? 'ON' : 'off'} · patch delay ${delay === null ? '–' : `${delay.toFixed(0)} ms`} · ${this.stats.fps.toFixed(0)} Hz`,
      24,
      H - 52,
    );
    ctx.fillText('A/X hide · B/Y whole frame · stick ↕ choose, ↔ change', 24, H - 20);
    const gl = this.gl!;
    gl.bindTexture(gl.TEXTURE_2D, this.hudTex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.hud);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    this.hudDirty = false;
    this.hudDrawnAt = now;
  }

  private pollControllers(session: XrSession, now: number): void {
    let dir: string | null = null;
    for (let i = 0; i < session.inputSources.length; i++) {
      const src = session.inputSources[i];
      const gp = src.gamepad;
      if (!gp || src.handedness === 'none') continue;
      // xr-standard: 4 = A / X, 5 = B / Y; axes 2, 3 = thumbstick (up is negative).
      if (this.pressedNow(`${src.handedness}4`, !!gp.buttons[4]?.pressed)) this.toggleSettings();
      if (this.pressedNow(`${src.handedness}5`, !!gp.buttons[5]?.pressed)) this.toggleFull();
      const x = gp.axes[2] ?? 0;
      const y = gp.axes[3] ?? 0;
      if (Math.max(Math.abs(x), Math.abs(y)) > 0.6) dir = Math.abs(x) > Math.abs(y) ? (x > 0 ? 'right' : 'left') : y > 0 ? 'down' : 'up';
    }
    if (!this.settingsShown || !dir) {
      this.stick = null;
      return;
    }
    if (dir !== this.stick) {
      this.stick = dir;
      this.stickRepeatAt = now + 400;
    } else if (now >= this.stickRepeatAt) {
      this.stickRepeatAt = now + (dir === 'up' || dir === 'down' ? 250 : 80);
    } else {
      return;
    }
    if (dir === 'up' || dir === 'down') {
      this.selected = (this.selected + (dir === 'down' ? 1 : -1) + SETTINGS.length) % SETTINGS.length;
    } else {
      this.change(SETTINGS[this.selected], dir === 'right' ? 1 : -1);
    }
    this.hudDirty = true;
  }

  private pressedNow(key: string, down: boolean): boolean {
    const was = this.buttons.get(key) ?? false;
    this.buttons.set(key, down);
    return down && !was;
  }

  private toggleSettings(): void {
    this.settingsShown = !this.settingsShown;
    this.hudDirty = true;
  }

  private toggleFull(): void {
    this.full = !this.full;
    this.opts.setFull(this.full);
    this.hudDirty = true;
    report('status', { text: `room view: whole frame ${this.full ? 'on' : 'off'}` });
  }

  private change(s: Setting, sign: number): void {
    const c = this.calib;
    if (s.key === 'side') c.side = c.side === 'left' ? 'right' : 'left';
    else {
      const v = (c[s.key] as number) + sign * s.step;
      (c[s.key] as number) = Math.min(s.max, Math.max(s.min, Math.round(v / s.step) * s.step));
    }
    if (s.key === 'cover' || s.key === 'fov' || s.key === 'distance') this.sendMargin();
    try {
      localStorage.setItem(CALIB_KEY, JSON.stringify(c));
    } catch {
      /* not kept, then */
    }
    // To the Mac's terminal, once the thumbstick rests: the values found for this Quest.
    clearTimeout(this.reportTimer);
    this.reportTimer = setTimeout(() => report('status', { text: `room view settings: ${this.describeCalibration()}` }), 1500);
  }

  private countFps(now: number): void {
    this.frames++;
    if (!this.fpsSince) this.fpsSince = now;
    if (now - this.fpsSince >= 1000) {
      this.stats.fps = (this.frames * 1000) / (now - this.fpsSince);
      this.frames = 0;
      this.fpsSince = now;
    }
  }
}
