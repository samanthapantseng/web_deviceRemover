import type { Rect } from '../types';

const FAR = 1e6;
const INF = 1e20;

/**
 * Exact Euclidean distance transform (Felzenszwalb & Huttenlocher) over a window of a mask.
 * One distance field gives us both a round dilation (distance <= r) and a smooth feather
 * (a ramp over the next few px), which a square max-filter plus blur would only approximate.
 */
export class DistanceField {
  private f = new Float64Array(0);
  private d = new Float64Array(0);
  private z = new Float64Array(0);
  private v = new Int32Array(0);

  /**
   * out[y * roi.w + x] = distance in px from (roi.x + x, roi.y + y) to the nearest pixel of `src`
   * that is > 0. Only pixels inside `roi` are considered. `out` must hold roi.w * roi.h values.
   */
  compute(src: Uint8Array, stride: number, roi: Rect, out: Float32Array): void {
    const { x: x0, y: y0, w, h } = roi;

    // Pass 1: distance along each row.
    for (let y = 0; y < h; y++) {
      const row = (y0 + y) * stride + x0;
      const o = y * w;
      let dist = FAR;
      for (let x = 0; x < w; x++) {
        dist = src[row + x] ? 0 : dist + 1;
        out[o + x] = dist;
      }
      dist = FAR;
      for (let x = w - 1; x >= 0; x--) {
        dist = src[row + x] ? 0 : dist + 1;
        if (dist < out[o + x]) out[o + x] = dist;
      }
    }

    // Pass 2: lower envelope of parabolas down each column.
    if (this.f.length < h) {
      this.f = new Float64Array(h);
      this.d = new Float64Array(h);
      this.z = new Float64Array(h + 1);
      this.v = new Int32Array(h);
    }
    const { f, d, z, v } = this;
    for (let x = 0; x < w; x++) {
      for (let y = 0; y < h; y++) {
        const g = out[y * w + x];
        f[y] = g >= FAR ? INF : g * g;
      }
      let k = 0;
      v[0] = 0;
      z[0] = -INF;
      z[1] = INF;
      for (let q = 1; q < h; q++) {
        let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
        while (s <= z[k]) {
          k--;
          s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
        }
        k++;
        v[k] = q;
        z[k] = s;
        z[k + 1] = INF;
      }
      k = 0;
      for (let q = 0; q < h; q++) {
        while (z[k + 1] < q) k++;
        const r = v[k];
        d[q] = (q - r) * (q - r) + f[r];
      }
      for (let y = 0; y < h; y++) out[y * w + x] = Math.sqrt(d[y]);
    }
  }
}
