// EXPERIMENTAL, only with `?gpuio=1`: model inputs and outputs that stay on the GPU, moved with
// buffers we create once and reuse. Not proven to stop Safari's memory growth (tried 2026-11-17).
//
// Why: for every run, onnxruntime-web's WebGPU provider uploads each CPU input and downloads each
// output through a new staging buffer that it releases without destroying, leaving the memory to
// garbage collection. Safari never gets round to it. Measured in Safari 26.6 on the Mac with the
// detector alone: the page grew by about 150 MB a second (2 GB → 7 GB in 30 s) and stayed there;
// with the same page on the CPU it stayed flat, and Chrome stayed flat either way. An iPad has a
// few GB in all, so Safari killed the page there within a minute.
//
// With IO binding the model reads its input from a GPU buffer we own (filled with writeBuffer)
// and leaves its outputs on the GPU; we copy them into a reused staging buffer and dispose them.
import * as ort from 'onnxruntime-web/webgpu';

// WebGPU constants (GPUBufferUsage, GPUMapMode); TypeScript's DOM types do not include WebGPU.
const MAP_READ = 0x1;
const COPY_SRC = 0x4;
const COPY_DST = 0x8;
const STORAGE = 0x80;
const MAP_MODE_READ = 0x1;

interface GpuBuffer {
  readonly size: number;
  mapAsync(mode: number): Promise<void>;
  getMappedRange(): ArrayBuffer;
  unmap(): void;
  destroy(): void;
}

interface GpuDevice {
  createBuffer(desc: { size: number; usage: number }): GpuBuffer;
  createCommandEncoder(): {
    copyBufferToBuffer(src: GpuBuffer, srcOffset: number, dst: GpuBuffer, dstOffset: number, size: number): void;
    finish(): unknown;
  };
  readonly queue: { writeBuffer(buffer: GpuBuffer, offset: number, data: ArrayBufferView): void; submit(commands: unknown[]): void };
}

export type TensorData = Float32Array | Uint8Array;

const align4 = (n: number) => Math.ceil(n / 4) * 4;

export class GpuIO {
  private inputs = new Map<string, GpuBuffer>();
  private staging = new Map<string, GpuBuffer>();
  private outputs = new Map<string, TensorData>();

  private constructor(private device: GpuDevice) {}

  /** For the device onnxruntime uses; call after a WebGPU session exists. */
  static async create(): Promise<GpuIO> {
    return new GpuIO((await ort.env.webgpu.device) as unknown as GpuDevice);
  }

  private buffer(map: Map<string, GpuBuffer>, name: string, size: number, usage: number): GpuBuffer {
    let buf = map.get(name);
    if (!buf || buf.size !== size) {
      buf?.destroy();
      buf = this.device.createBuffer({ size, usage });
      map.set(name, buf);
    }
    return buf;
  }

  /** A GPU tensor with a copy of `data`, in the buffer kept for this input name. */
  input(name: string, data: TensorData, dims: readonly number[]): ort.Tensor {
    const buf = this.buffer(this.inputs, name, align4(data.byteLength), STORAGE | COPY_DST | COPY_SRC);
    this.device.queue.writeBuffer(buf, 0, data);
    const dataType = data instanceof Float32Array ? 'float32' : 'uint8';
    return ort.Tensor.fromGpuBuffer(buf as never, { dataType, dims });
  }

  /** Copies a GPU output to the CPU, into an array kept for this output name, and disposes the tensor. */
  async read(name: string, tensor: ort.Tensor): Promise<TensorData> {
    const count = tensor.dims.reduce((a, b) => a * b, 1);
    const float = tensor.type === 'float32';
    if (!float && tensor.type !== 'uint8') throw new Error(`GpuIO: unsupported output type ${tensor.type}`);
    const bytes = count * (float ? 4 : 1);
    const size = align4(bytes);
    const staging = this.buffer(this.staging, name, size, MAP_READ | COPY_DST);
    const enc = this.device.createCommandEncoder();
    enc.copyBufferToBuffer(tensor.gpuBuffer as unknown as GpuBuffer, 0, staging, 0, size);
    this.device.queue.submit([enc.finish()]);
    await staging.mapAsync(MAP_MODE_READ);
    let out = this.outputs.get(name);
    if (!out || out.length !== count || out instanceof Float32Array !== float) {
      out = float ? new Float32Array(count) : new Uint8Array(count);
      this.outputs.set(name, out);
    }
    const mapped = staging.getMappedRange();
    out.set(float ? new Float32Array(mapped, 0, count) : new Uint8Array(mapped, 0, count));
    staging.unmap();
    tensor.dispose();
    return out;
  }
}
