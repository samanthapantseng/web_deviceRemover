// onnxruntime-web setup shared by every model.
//
// We import the `/webgpu` entry: in onnxruntime-web 1.31 that is the build with the native
// WebGPU execution provider (ort-wasm-simd-threaded.asyncify.wasm). The same binary also
// contains the CPU (WASM) provider, which is the fallback when WebGPU is unavailable.
import * as ort from 'onnxruntime-web/webgpu';
import { GpuIO, type TensorData } from './gpuIO';

export { ort };
export type Backend = 'webgpu' | 'wasm';

let configured = false;

function configure(gpu: boolean): void {
  if (configured) return;
  configured = true;
  // The .wasm is copied to public/ort/ by scripts/copy_ort.mjs, so nothing is fetched from a CDN.
  const wasm = new URL(`${import.meta.env.BASE_URL}ort/ort-wasm-simd-threaded.asyncify.wasm`, document.baseURI).href;
  ort.env.wasm.wasmPaths = { wasm };
  // CPU threads only help the CPU fallback; with WebGPU the CPU does next to nothing, and every
  // extra thread is another worker holding memory (which matters on an iPad).
  // Threads need cross-origin isolation (COOP/COEP headers, set by the Vite dev/preview server).
  ort.env.wasm.numThreads = !gpu && self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;
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

export type Inputs = Record<string, { data: TensorData; dims: readonly number[] }>;
export type Outputs = Record<string, { data: TensorData; dims: readonly number[] }>;

/** A loaded model. Runs are queued (see `exclusive`); outputs always come back on the CPU. */
export class Model {
  constructor(
    readonly session: ort.InferenceSession,
    readonly backend: Backend,
    private io: GpuIO | null,
  ) {}

  /** Runs the model and returns its outputs on the CPU. Output arrays may be reused by the next run. */
  run(inputs: Inputs): Promise<Outputs> {
    return exclusive(async () => {
      try {
        return await this.runOnce(inputs);
      } catch (err) {
        if (!this.io) throw err;
        // Keep the show going: fall back to onnxruntime's own transfers.
        console.warn('[ort] GPU input/output failed, falling back', err);
        this.io = null;
        return this.runOnce(inputs);
      }
    });
  }

  private async runOnce(inputs: Inputs): Promise<Outputs> {
    const io = this.io;
    const feeds: Record<string, ort.Tensor> = {};
    for (const [name, { data, dims }] of Object.entries(inputs)) {
      feeds[name] = io
        ? io.input(name, data, dims)
        : new ort.Tensor(data instanceof Float32Array ? 'float32' : 'uint8', feedData(data), dims);
    }
    const results = await this.session.run(feeds);
    const out: Outputs = {};
    for (const [name, t] of Object.entries(results)) {
      let data: TensorData;
      if (t.location !== 'gpu-buffer') data = t.data as TensorData;
      else if (io) data = await io.read(name, t);
      else data = (await t.getData(true)) as TensorData;
      out[name] = { data, dims: t.dims };
    }
    return out;
  }
}

/**
 * WebGPU options. EXPERIMENTAL, off by default: `?cache=simple` makes onnxruntime reuse every GPU
 * buffer instead of creating some anew for each run. Tried against Safari's memory growth on the
 * iPad (see DEVLOG, 2026-11-17); not proven to help, so the default stays onnxruntime's own.
 */
function webgpuProvider(): ort.InferenceSession.WebGpuExecutionProviderOption {
  if (new URLSearchParams(location.search).get('cache') !== 'simple') return { name: 'webgpu' };
  return {
    name: 'webgpu',
    storageBufferCacheMode: 'simple',
    uniformBufferCacheMode: 'simple',
    queryResolveBufferCacheMode: 'simple',
    defaultBufferCacheMode: 'simple',
  };
}

export async function createSession(model: Uint8Array, opts: { freeDims?: Record<string, number> } = {}): Promise<Model> {
  const gpu = forcedBackend() !== 'wasm' && (await hasWebGPU());
  configure(gpu);
  // EXPERIMENTAL, off by default: `?gpuio=1` keeps model inputs/outputs on the GPU (gpuIO.ts).
  const gpuIO = new URLSearchParams(location.search).get('gpuio') === '1';
  const order: Backend[] = gpu ? ['webgpu', 'wasm'] : ['wasm'];
  let lastError: unknown;
  for (const backend of order) {
    try {
      const onGpu = backend === 'webgpu' && gpuIO;
      const session = await ort.InferenceSession.create(model, {
        executionProviders: [backend === 'webgpu' ? webgpuProvider() : backend],
        graphOptimizationLevel: 'all',
        freeDimensionOverrides: opts.freeDims,
        ...(onGpu ? { preferredOutputLocation: 'gpu-buffer' as const } : {}),
      });
      return new Model(session, backend, onGpu ? await GpuIO.create() : null);
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
