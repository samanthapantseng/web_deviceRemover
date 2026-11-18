import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin, type ServerOptions } from 'vite';
import { formatLinkReport, signalHub } from './server/signalHub.ts';

const root = dirname(fileURLToPath(import.meta.url));
const capturesDir = join(root, 'captures');

// Needed for multi-threaded WASM (SharedArrayBuffer), i.e. the non-WebGPU fallback.
const isolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

/** Requests from this Mac itself. In iPad mode the server is also reachable from the network. */
function fromThisMac(req: IncomingMessage): boolean {
  const a = req.socket.remoteAddress ?? '';
  return a === '::1' || a.startsWith('127.') || a.startsWith('::ffff:127.');
}

function readBody(req: IncomingMessage, res: ServerResponse, limit: number, done: (body: Buffer) => void): void {
  const chunks: Buffer[] = [];
  let size = 0;
  req.on('data', (c: Buffer) => {
    size += c.length;
    if (size > limit) {
      res.statusCode = 413;
      res.end('too large');
      req.destroy();
      return;
    }
    chunks.push(c);
  });
  req.on('end', () => size <= limit && done(Buffer.concat(chunks)));
}

/**
 * Dev-server only. Lets the still-image test page (still.html) write a PNG into ./captures/
 * when a frame is captured, and read it back as a test fixture. Not part of the built app:
 * the live view never talks to this. Reading back is only allowed from this Mac, since the
 * captures can show faces and the iPad mode puts the server on the network.
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
        readBody(req, res, 20 * 1024 * 1024, (body) => {
          mkdirSync(capturesDir, { recursive: true });
          writeFileSync(join(capturesDir, name), body);
          res.end('ok');
        });
      });
      server.middlewares.use('/captures', (req, res, next) => {
        if (!fromThisMac(req)) {
          res.statusCode = 403;
          res.end('forbidden');
          return;
        }
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

/**
 * Dev server only. In iPad mode (or with ?report in the URL) the page sends timings, errors and
 * status messages (never images) to
 * POST /__report; they are appended to captures/device-report.jsonl, and errors, status
 * messages and a timing line every 30 s are printed in this terminal. That way a test run on
 * the iPad can be read on the Mac.
 */
function devReport(): Plugin {
  const file = join(capturesDir, 'device-report.jsonl');
  const lastStatsPrint = new Map<string, number>();
  const n = (v: unknown, digits = 0) => (typeof v === 'number' ? v.toFixed(digits) : '–');
  return {
    name: 'device-remover:dev-report',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__report', (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.end();
          return;
        }
        readBody(req, res, 256 * 1024, (body) => {
          res.end('ok');
          let r: Record<string, unknown>;
          try {
            r = JSON.parse(body.toString('utf8')) as Record<string, unknown>;
          } catch {
            return;
          }
          const entry = { t: new Date().toISOString(), from: req.socket.remoteAddress, ...r };
          mkdirSync(capturesDir, { recursive: true });
          appendFileSync(file, `${JSON.stringify(entry)}\n`);

          const who = `[${String(r.device ?? 'device')}${r.page === '/still.html' ? ' · still' : ''}]`;
          const now = Date.now();
          if (r.kind === 'stats') {
            if (now - (lastStatsPrint.get(who) ?? 0) < 30_000) return;
            lastStatsPrint.set(who, now);
            console.log(
              `${who} display ${n(r.displayFps)} fps · fill ${n(r.pipelineFps, 1)} fps · detect ${n(r.detectMs)} ms · ` +
                `inpaint ${n(r.inpaintMs)} ms · phones ${n(r.phones)} · ${String(r.detector)} · ${String(r.fill)}`,
            );
          } else if (r.kind === 'link') {
            // Streaming mode: connection stats from the iPad's stream page or the Mac page.
            const key = `${who} link`;
            if (now - (lastStatsPrint.get(key) ?? 0) < 30_000) return;
            lastStatsPrint.set(key, now);
            console.log(formatLinkReport(who, r));
          } else if (r.kind === 'hello') {
            console.log(`${who} connected · WebGPU ${r.webgpu ? 'yes' : 'NO'} · ${String(r.gpu ?? '')} · ${String(r.userAgent)}`);
          } else if (r.kind === 'still') {
            console.log(`${who} still test: ${JSON.stringify(r.summary)}`);
          } else {
            console.log(`${who} ${String(r.kind)}: ${String(r.text ?? r.message ?? '')}`.slice(0, 600));
          }
        });
      });
    },
  };
}

/**
 * `npm run dev:ipad`: https on the local network, so Safari on an iPad can open the page and
 * use the camera. The certificate comes from scripts/make_cert.sh. Port 8443, so the plain
 * `npm run dev` on 5173 can keep running next to it.
 */
function ipadServer(): ServerOptions {
  const dir = process.env.DEVICE_REMOVER_CERTS ?? join(homedir(), 'Library/Application Support/Device Remover/certs');
  const key = join(dir, 'server.key');
  const cert = join(dir, 'server.pem');
  if (!existsSync(key) || !existsSync(cert)) {
    throw new Error(`No https certificate in ${dir}. Start with "npm run dev:ipad", which makes one.`);
  }
  return {
    host: true,
    port: 8443,
    strictPort: true,
    https: { key: readFileSync(key), cert: readFileSync(cert) },
    // Vite only answers to localhost and IP addresses unless told otherwise; the iPad uses the
    // Mac's Bonjour name (<name>.local), which stays the same on every network.
    allowedHosts: ['.local'],
    headers: isolationHeaders,
  };
}

function printIpadUrl(): Plugin {
  return {
    name: 'device-remover:ipad-url',
    apply: 'serve',
    configureServer(server) {
      server.httpServer?.once('listening', () => {
        let host = 'this-mac';
        try {
          host = execFileSync('scutil', ['--get', 'LocalHostName'], { encoding: 'utf8' }).trim();
        } catch {
          /* not macOS: the Network addresses Vite prints work too */
        }
        const port = server.config.server.port ?? 8443;
        setTimeout(() => {
          console.log(`\n  iPad:  https://${host}.local:${port}/    still test: https://${host}.local:${port}/still.html`);
          console.log('  The iPad must be on the same Wi-Fi and trust the certificate (README, "Testing on the iPad").');
          console.log(`  Streaming mode: iPad  https://${host}.local:${port}/stream.html  (or the Network address + /stream.html)`);
          console.log(`                  Mac   npm run stream:mac  (opens https://localhost:${port}/?source=stream)\n`);
        }, 50);
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  const ipad = mode === 'ipad';
  return {
    // Relative base so the build works from any sub-path (GitHub Pages project sites).
    base: './',
    plugins: [devCaptures(), devReport(), ...(ipad ? [signalHub(), printIpadUrl()] : [])],
    server: {
      ...(ipad ? ipadServer() : { headers: isolationHeaders }),
      // Test stills (faces) are only handed out by devCaptures above, and only to this Mac.
      fs: { deny: ['.env', '.env.*', '*.{crt,pem,key,p12,pfx,cer,der}', '.npmrc', '.yarnrc.yml', '**/.git/**', '**/captures/**'] },
    },
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
  };
});
