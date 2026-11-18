import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';

/**
 * Streaming mode (the iPad's camera and screen, the Mac does the work), `npm run dev:ipad` only.
 *
 * Introduces the iPad's stream page (stream.html) and the Mac's processing page
 * (/?source=stream) to each other, so they can open a direct WebRTC connection on the local
 * network. Only connection details pass through here (codecs, addresses, ports), never frames.
 *
 *   GET  /__signal/events?role=ipad|mac   Server-Sent Events: hello, peer, message, replaced
 *   POST /__signal?role=ipad|mac           a JSON message, forwarded to the other side
 *                                          (409 if the other side is not connected)
 *
 * One page per role: a newer page replaces the older one, which is told so and stops. The
 * Mac role is only accepted from this Mac. The iPad role is open to the network, so on a
 * shared network someone else opening the stream page would take over the screen (README).
 */

type Role = 'ipad' | 'mac';

interface Client {
  id: number;
  res: ServerResponse;
  from: string;
  heartbeat: ReturnType<typeof setInterval>;
}

const NAME: Record<Role, string> = { ipad: 'iPad', mac: 'Mac' };
const other = (r: Role): Role => (r === 'ipad' ? 'mac' : 'ipad');

function fromThisMac(req: IncomingMessage): boolean {
  const a = req.socket.remoteAddress ?? '';
  return a === '::1' || a.startsWith('127.') || a.startsWith('::ffff:127.');
}

function address(req: IncomingMessage): string {
  return (req.socket.remoteAddress ?? '?').replace(/^::ffff:/, '');
}

function event(c: Client, name: string, data: unknown): void {
  c.res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
}

function log(text: string): void {
  const t = new Date().toTimeString().slice(0, 8);
  console.log(`${t} [stream] ${text}`);
}

export function signalHub(): Plugin {
  const clients: Partial<Record<Role, Client>> = {};
  let nextId = 1;

  function openEvents(role: Role, req: IncomingMessage, res: ServerResponse): void {
    // No Connection header: the https dev server speaks HTTP/2, which forbids it.
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store' });
    // Reconnect after 1 s (instead of the browser's default 3 s) when the stream drops.
    res.write('retry: 1000\n\n');
    const c: Client = { id: nextId++, res, from: address(req), heartbeat: setInterval(() => res.write(': ping\n\n'), 15_000) };
    const previous = clients[role];
    clients[role] = c;
    if (previous) {
      event(previous, 'replaced', {});
      clearInterval(previous.heartbeat);
      previous.res.end();
    }
    const peer = clients[other(role)];
    event(c, 'hello', { id: c.id, peer: !!peer });
    if (peer) event(peer, 'peer', { role, present: true });
    log(`${NAME[role]} page connected${role === 'ipad' ? ` from ${c.from}` : ''}${previous ? ' (replaces the previous one)' : ''}`);

    res.on('close', () => {
      clearInterval(c.heartbeat);
      if (clients[role] !== c) return; // replaced by a newer page
      delete clients[role];
      const p = clients[other(role)];
      if (p) event(p, 'peer', { role, present: false });
      log(`${NAME[role]} page gone`);
    });
  }

  function forward(role: Role, req: IncomingMessage, res: ServerResponse): void {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 64 * 1024) {
        res.statusCode = 413;
        res.end('too large');
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (size > 64 * 1024) return;
      let msg: { type?: unknown };
      try {
        msg = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { type?: unknown };
      } catch {
        res.statusCode = 400;
        res.end('bad json');
        return;
      }
      const peer = clients[other(role)];
      if (!peer) {
        res.statusCode = 409;
        res.end(`${NAME[other(role)]} not connected`);
        return;
      }
      event(peer, 'message', msg);
      res.end('ok');
      if (msg.type === 'offer') log(`${NAME[role]} → ${NAME[other(role)]}: new connection`);
    });
  }

  return {
    name: 'device-remover:signal-hub',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__signal', (req, res) => {
        const url = new URL(req.url ?? '', 'http://localhost');
        const role = url.searchParams.get('role');
        if (role !== 'ipad' && role !== 'mac') {
          res.statusCode = 400;
          res.end('role must be ipad or mac');
          return;
        }
        if (role === 'mac' && !fromThisMac(req)) {
          res.statusCode = 403;
          res.end('the Mac page only works on this Mac');
          return;
        }
        if (req.method === 'GET' && url.pathname === '/events') openEvents(role, req, res);
        else if (req.method === 'POST' && (url.pathname === '/' || url.pathname === '')) forward(role, req, res);
        else {
          res.statusCode = 404;
          res.end();
        }
      });
    },
  };
}

const n = (v: unknown, digits = 0): string => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(digits) : '–');

/** One terminal line for a `link` report (connection stats from either page). */
export function formatLinkReport(who: string, r: Record<string, unknown>): string {
  const latency = typeof r.latencyMs === 'number' ? ` · round trip ${n(r.latencyMs)} ms (p95 ${n(r.latencyP95)})` : '';
  const shown = typeof r.shownFps === 'number' ? ` · shown ${n(r.shownFps)} fps` : '';
  return (
    `${who} link ${String(r.state ?? '?')} · ${String(r.route ?? '?')} · rtt ${n(r.rttMs)} ms · ` +
    `in ${n(r.inFps)} fps ${n(r.inKbps)} kb/s ${String(r.inRes ?? '–')} · out ${n(r.outFps)} fps ${n(r.outKbps)} kb/s ${String(r.outRes ?? '–')} · ` +
    `${String(r.codec ?? '?')} · buffer ${n(r.bufferMs)} ms · dropped ${n(r.dropped)} · freezes ${n(r.freezes)}${shown}${latency}`
  );
}
