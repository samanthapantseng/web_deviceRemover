// onnxruntime-web setup shared by every model.
//
// We import the `/webgpu` entry: in onnxruntime-web 1.31 that is the build with the native
// WebGPU execution provider (ort-wasm-simd-threaded.asyncify.wasm). The same binary also
// contains the CPU (WASM) provider, which is the fallback when WebGPU is unavailable.
import * as ort from 'onnxruntime-web/webgpu';

export { ort };
export type Backend = 'webgpu' | 'wasm';

let configured = false;

function configure(gpu: boolean): void {
  if (configured) return;
  configured = true;
  // The .wasm is copied to public/ort/ by scripts/copy_ort.mjs, so nothing is fetched from a CDN.
  const wasm = new URL(`${import.meta.env.BASE_URL}ort/ort-wasm-simd-threaded.asyncify.wasm`, document.baseURI).href;
  ort.env.wasm.wasmPaths = { wasm };
  // Threads need cross-origin isolation (COOP/COEP headers, set by the Vite dev/preview server).
  ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;
  // Without WebGPU every inference is hundreds of ms of CPU work. Run it in a worker so that
  // at least the camera image keeps moving smoothly while the fill lags behind.
  ort.env.wasm.proxy = !gpu;
  ort.env.logLevel = 'warning';
}

/**
 * Wrap reusable input buffers with this before building a tensor. In worker (proxy) mode
 * onnxruntime-web *transfers* the tensor's buffer to the worker, which would leave our
 * reused array detached (length 0) after the first run; so there we hand over a copy.
 */
export function feedData<T extends Float32Array | Uint8Array>(data: T): T {
  return (ort.env.wasm.proxy ? data.slice() : data) as T;
}

let gpuCheck: Promise<boolean> | null = null;

export function hasWebGPU(): Promise<boolean> {
  gpuCheck ??= (async () => {
    const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
    if (!gpu) return false;
    try {
      return (await gpu.requestAdapter()) != null;
    } catch {
      return false;
    }
  })();
  return gpuCheck;
}

/** `?backend=wasm` in the URL forces the CPU fallback, for testing it. */
export function forcedBackend(): Backend | null {
  const b = new URLSearchParams(location.search).get('backend');
  return b === 'wasm' || b === 'webgpu' ? b : null;
}

export function modelUrl(file: string): string {
  return new URL(`${import.meta.env.BASE_URL}models/${file}`, document.baseURI).href;
}

export async function fetchModel(url: string, onProgress?: (fraction: number) => void): Promise<Uint8Array> {
  const res = await fetch(url);
  const type = res.headers.get('content-type') ?? '';
  if (!res.ok || type.includes('text/html')) {
    throw new Error(`Model not found: ${url}. Run "npm run models" to download/export it.`);
  }
  const total = Number(res.headers.get('content-length')) || 0;
  if (!res.body || !onProgress || !total) return new Uint8Array(await res.arrayBuffer());
  const out = new Uint8Array(total);
  const reader = res.body.getReader();
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (loaded + value.length > out.length) return new Uint8Array(await (await fetch(url)).arrayBuffer());
    out.set(value, loaded);
    loaded += value.length;
    onProgress(loaded / total);
  }
  return out;
}

export interface LoadedSession {
  session: ort.InferenceSession;
  backend: Backend;
}

export async function createSession(
  model: Uint8Array,
  opts: { freeDims?: Record<string, number> } = {},
): Promise<LoadedSession> {
  const gpu = forcedBackend() !== 'wasm' && (await hasWebGPU());
  configure(gpu);
  const order: Backend[] = gpu ? ['webgpu', 'wasm'] : ['wasm'];
  let lastError: unknown;
  for (const backend of order) {
    try {
      const session = await ort.InferenceSession.create(model, {
        executionProviders: [backend],
        graphOptimizationLevel: 'all',
        freeDimensionOverrides: opts.freeDims,
      });
      return { session, backend };
    } catch (err) {
      lastError = err;
      console.warn(`[ort] could not create a ${backend} session`, err);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

// All sessions share one WASM instance and one GPU device, and onnxruntime-web does not
// support overlapping run() calls, so every inference goes through this queue.
let queue: Promise<unknown> = Promise.resolve();

export function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const next = queue.then(fn, fn);
  queue = next.catch(() => undefined);
  return next;
}
