/**
 * Remote diagnostics for testing on the iPad (`npm run dev:ipad` only). The page sends its
 * timings, errors and status messages to the Mac's dev server, which appends them to
 * captures/device-report.jsonl and prints the important ones in its terminal. Never images.
 *
 * Inactive with the plain `npm run dev`, and compiled out of the production build.
 */
export const reporting =
  import.meta.env.DEV && (import.meta.env.MODE === 'ipad' || new URLSearchParams(location.search).has('report'));

// WebAssembly memories created by this page (onnxruntime's), so their growth can be reported.
const wasmMemories: WebAssembly.Memory[] = [];
if (reporting) {
  const Original = WebAssembly.Memory;
  const Tracked = function (desc: WebAssembly.MemoryDescriptor) {
    const m = new Original(desc);
    wasmMemories.push(m);
    return m;
  } as unknown as typeof WebAssembly.Memory;
  Tracked.prototype = Original.prototype;
  (WebAssembly as { Memory: typeof WebAssembly.Memory }).Memory = Tracked;
}

/** Current size of each tracked WebAssembly memory, in MB. */
export function wasmMemoryMB(): number[] {
  return wasmMemories.map((m) => Math.round(m.buffer.byteLength / 2 ** 20));
}

function deviceName(): string {
  const ua = navigator.userAgent;
  const touch = navigator.maxTouchPoints > 0;
  const os = /iPad/.test(ua) || (/Macintosh/.test(ua) && touch) ? 'iPad' : /iPhone/.test(ua) ? 'iPhone' : /Mac/.test(ua) ? 'Mac' : 'device';
  const browser = /CriOS|Chrome\//.test(ua) ? 'Chrome' : /FxiOS|Firefox/.test(ua) ? 'Firefox' : /Safari/.test(ua) ? 'Safari' : 'browser';
  return `${os} ${browser}`;
}

const device = reporting ? deviceName() : '';

export function report(kind: string, data: Record<string, unknown> = {}): void {
  if (!reporting) return;
  const body = JSON.stringify({ kind, device, page: location.pathname, ...data });
  void fetch('__report', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }).catch(() => undefined);
}

function describe(v: unknown): string {
  if (v instanceof Error) return v.stack && !v.stack.includes(v.message) ? `${v.message}\n${v.stack}` : (v.stack ?? v.message);
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

// At most 30 error/warning reports a minute, so a frame failing in a loop cannot flood the Mac.
let budget = 30;

function problem(kind: 'error' | 'warn', message: string): void {
  // eslint-disable-next-line no-control-regex -- onnxruntime colours its log lines
  const text = message.replace(/\x1b\[[0-9;]*m/g, '');
  // onnxruntime's routine note that it runs shape calculations on the CPU: not a problem.
  if (/VerifyEachNodeIsAssignedToAnEp/.test(text)) return;
  // onnxruntime logs its warnings through console.error.
  if (/\[W:onnxruntime/.test(text)) kind = 'warn';
  if (budget-- > 0) report(kind, { message: text.slice(0, 2000) });
}

interface GpuAdapterLike {
  info?: { vendor?: string; architecture?: string; device?: string; description?: string };
  features: Iterable<string>;
  limits: Record<string, number>;
}

async function probeWebGpu(): Promise<Record<string, unknown>> {
  const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<GpuAdapterLike | null> } }).gpu;
  if (!gpu) return { webgpu: false, gpu: 'navigator.gpu missing' };
  try {
    const adapter = await gpu.requestAdapter();
    if (!adapter) return { webgpu: false, gpu: 'no adapter' };
    const i = adapter.info ?? {};
    const l = adapter.limits;
    return {
      webgpu: true,
      gpu: [i.vendor, i.architecture, i.device, i.description].filter(Boolean).join(' ') || 'adapter (no info)',
      features: [...adapter.features],
      limits: {
        maxBufferSize: l.maxBufferSize,
        maxStorageBufferBindingSize: l.maxStorageBufferBindingSize,
        maxComputeWorkgroupStorageSize: l.maxComputeWorkgroupStorageSize,
        maxComputeInvocationsPerWorkgroup: l.maxComputeInvocationsPerWorkgroup,
        maxStorageBuffersPerShaderStage: l.maxStorageBuffersPerShaderStage,
      },
    };
  } catch (err) {
    return { webgpu: false, gpu: `requestAdapter failed: ${describe(err)}` };
  }
}

/** Forward uncaught errors and console errors/warnings, and say hello with what the browser supports. */
export function startReporting(): void {
  if (!reporting) return;
  setInterval(() => (budget = 30), 60_000);
  addEventListener('error', (e) => problem('error', `${e.message} (${e.filename}:${e.lineno})`));
  addEventListener('unhandledrejection', (e) => problem('error', `unhandled: ${describe(e.reason)}`));
  for (const level of ['error', 'warn'] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      original(...args);
      problem(level, args.map(describe).join(' '));
    };
  }
  void probeWebGpu().then((gpu) =>
    report('hello', {
      userAgent: navigator.userAgent,
      screen: `${screen.width}×${screen.height} @${devicePixelRatio}x`,
      cores: navigator.hardwareConcurrency,
      crossOriginIsolated: self.crossOriginIsolated,
      ...gpu,
    }),
  );
}
