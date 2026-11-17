// Copies the onnxruntime-web WebAssembly binary into public/ort/ so the app loads it from
// its own origin (works offline and from any base path, e.g. GitHub Pages).
// Runs on `npm install`; run `npm run copy-ort` by hand after upgrading onnxruntime-web.
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The build used by `onnxruntime-web/webgpu` (see src/runtime/ort.ts).
const FILE = 'ort-wasm-simd-threaded.asyncify.wasm';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'node_modules', 'onnxruntime-web', 'dist', FILE);
const dst = join(root, 'public', 'ort');

if (!existsSync(src)) {
  console.warn(`[copy_ort] ${FILE} not found (is onnxruntime-web installed?), skipping`);
  process.exit(0);
}
rmSync(dst, { recursive: true, force: true });
mkdirSync(dst, { recursive: true });
cpSync(src, join(dst, FILE));
console.log(`[copy_ort] copied ${FILE} to public/ort/`);
