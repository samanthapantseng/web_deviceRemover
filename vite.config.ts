import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';

const root = dirname(fileURLToPath(import.meta.url));
const capturesDir = join(root, 'captures');

// Needed for multi-threaded WASM (SharedArrayBuffer), i.e. the non-WebGPU fallback.
const isolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

/**
 * Dev-server only. Lets the still-image test page (still.html) write a PNG into ./captures/
 * when its "save" button is pressed, and read it back as a test fixture. Not part of the
 * built app: the live view never talks to this.
 */
function devCaptures(): Plugin {
  const safeName = (raw: string | null) => (raw && /^[\w-]{1,64}\.png$/.test(raw) ? raw : null);
  return {
    name: 'device-remover:dev-captures',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__capture', (req, res) => {
        const name = safeName(new URL(req.url ?? '', 'http://localhost').searchParams.get('name'));
        if (req.method !== 'POST' || !name) {
          res.statusCode = 400;
          res.end('bad request');
          return;
        }
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
          mkdirSync(capturesDir, { recursive: true });
          writeFileSync(join(capturesDir, name), Buffer.concat(chunks));
          res.end('ok');
        });
      });
      server.middlewares.use('/captures', (req, res, next) => {
        const name = safeName((req.url ?? '').split('?')[0].replace(/^\//, ''));
        const file = name ? join(capturesDir, name) : null;
        if (!file || !existsSync(file)) return next();
        res.setHeader('Content-Type', 'image/png');
        res.setHeader('Cache-Control', 'no-store');
        res.end(readFileSync(file));
      });
    },
  };
}

export default defineConfig({
  // Relative base so the build works from any sub-path (GitHub Pages project sites).
  base: './',
  plugins: [devCaptures()],
  server: { headers: isolationHeaders },
  preview: { headers: isolationHeaders },
  // onnxruntime-web ships pre-bundled ESM that locates its own .wasm; don't let Vite re-bundle it.
  optimizeDeps: { exclude: ['onnxruntime-web'] },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 12000,
    rolldownOptions: {
      input: {
        main: resolve(root, 'index.html'),
        still: resolve(root, 'still.html'),
      },
      output: {
        codeSplitting: {
          groups: [
            // onnxruntime-web starts its worker threads (and its CPU-fallback worker) by loading
            // its own file again inside a Worker. That only works if the file holds nothing but
            // onnxruntime: sharing a chunk with app code crashes the worker on `document`.
            { name: 'ort', test: /node_modules[\\/]onnxruntime-(web|common)[\\/]/ },
          ],
        },
      },
    },
  },
});
