// MI-GAN (Sargsyan et al., ICCV 2023) inpainting.
//
// Model: https://huggingface.co/andraniksargsyan/migan/resolve/main/migan.onnx (MIT)
// I/O (verified with scripts/inspect_onnx.py and a probe run):
//   image   uint8 [N, 3, H, W]   RGB
//   mask    uint8 [N, 1, H, W]   255 = keep, 0 = fill
//   result  uint8 [N, 3, H, W]   RGB; pixels where mask == 255 come back unchanged
// The graph resizes to 512×512 internally, so the generator costs the same whatever we feed it.
// We always feed exactly 512×512: fixed shapes keep the GPU pipelines cached.
import { createSession, fetchModel, modelUrl, type Backend, type Model } from '../runtime/ort';
import { makeCanvas } from '../types';
import { sampleHole, type Fill, type FillJob } from './types';

const S = 512;

export class MiganFill implements Fill {
  readonly id = 'migan' as const;
  readonly label = 'MI-GAN';
  // Measured on test frames: with the hole filling a third of the window MI-GAN invents
  // objects in the hand; once the hole is under ~15 % of the window it continues the background.
  readonly context = 2.6;
  private model!: Model;
  private be: Backend | 'not loaded' = 'not loaded';
  private inp = makeCanvas(S, S, true);
  private out = makeCanvas(S, S, true);
  private image = new Uint8Array(3 * S * S);
  private mask = new Uint8Array(S * S);
  private result = new ImageData(S, S);

  backend(): string {
    return this.be;
  }

  async init(onProgress?: (fraction: number) => void): Promise<void> {
    const bytes = await fetchModel(modelUrl('migan.onnx'), onProgress);
    this.model = await createSession(bytes, { freeDims: { batch_size: 1, height: S, width: S } });
    this.be = this.model.backend;
    this.mask.fill(255);
    this.mask.fill(0, (S * S) / 2 - S * 32, (S * S) / 2 + S * 32);
    await this.infer(); // warm-up: compiles shaders
  }

  private async infer(): Promise<Uint8Array> {
    const res = await this.model.run({
      image: { data: this.image, dims: [1, 3, S, S] },
      mask: { data: this.mask, dims: [1, 1, S, S] },
    });
    return res.result.data as Uint8Array;
  }

  async run(job: FillJob): Promise<HTMLCanvasElement> {
    const { rect } = job;
    const { ctx } = this.inp;
    ctx.drawImage(job.frame, rect.x, rect.y, rect.w, rect.h, 0, 0, S, S);
    const rgba = ctx.getImageData(0, 0, S, S).data;
    const plane = S * S;
    const image = this.image;
    for (let i = 0, p = 0; i < plane; i++, p += 4) {
      image[i] = rgba[p];
      image[plane + i] = rgba[p + 1];
      image[2 * plane + i] = rgba[p + 2];
    }
    sampleHole(job, S, S, this.mask, 0, 255);

    const out = await this.infer();

    const px = this.result.data;
    for (let i = 0, p = 0; i < plane; i++, p += 4) {
      px[p] = out[i];
      px[p + 1] = out[plane + i];
      px[p + 2] = out[2 * plane + i];
      px[p + 3] = 255;
    }
    this.out.ctx.putImageData(this.result, 0, 0);
    return this.out.canvas;
  }
}
