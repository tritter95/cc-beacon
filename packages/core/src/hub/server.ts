// The hub: owns the fixed loopback port, receives every hook POST, routes each event to the one
// window that owns its session, and streams it to that window (in-process for its own window).
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { normalize } from '../claude/normalize';
import type { RoutedEvent, WindowInfo } from '../model';
import type { Router } from '../routing/router';
import { PATHS, PING_INTERVAL_MS, PROTOCOL_VERSION, type Health } from './protocol';
import { BodyTooLarge, checkRequest, readBody, type RejectReason } from './security';

export interface HubServerOptions {
  port: number;
  token: string;
  version: string;
  localWindowId: string;
  router: Router;
  onLocalEvent: (r: RoutedEvent) => void;
  log: (msg: string) => void;
  /** Keep message text in the diagnostics ring buffer (off by default). */
  includeMessageText?: () => boolean;
}

export interface RecentEvent {
  at: number;
  hook: string;
  type?: string;
  session: string;
  entrypoint?: string;
  windowId?: string;
  via?: string;
  dropped?: string;
  detail?: string;
}

export interface HubDiagnostics {
  role: 'hub';
  pid: number;
  port: number;
  version: string;
  protocol: number;
  hubWindowId: string;
  startedAt: number;
  windows: WindowInfo[];
  bindings: { session: string; windowId: string; terminalShellPid?: number }[];
  received: number;
  rejected: Partial<Record<RejectReason | 'bad-json', number>>;
  recent: RecentEvent[];
}

const RECENT_MAX = 50;
const WINDOW_PATH = /^\/cc-beacon\/v1\/windows\/([A-Za-z0-9_-]{1,64})(\/stream)?$/;

export class HubServer {
  private server?: http.Server;
  private streams = new Map<string, ServerResponse>();
  private chains = new Map<string, Promise<void>>();
  private recent: RecentEvent[] = [];
  private rejected: HubDiagnostics['rejected'] = {};
  private received = 0;
  private ping?: NodeJS.Timeout;
  private readonly startedAt = Date.now();

  constructor(private readonly opts: HubServerOptions) {}

  get router(): Router {
    return this.opts.router;
  }

  /** Resolves once listening; rejects with the listen error (EADDRINUSE when another hub has the port). */
  listen(): Promise<number> {
    const server = http.createServer((req, res) => this.handle(req, res));
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.opts.port, '127.0.0.1', () => {
        server.off('error', reject);
        server.on('error', (e) => this.opts.log(`hub server error: ${e.message}`));
        this.server = server;
        this.ping = setInterval(() => this.broadcast(': ping\n\n'), PING_INTERVAL_MS);
        this.ping.unref();
        resolve((server.address() as AddressInfo).port);
      });
    });
  }

  async close(): Promise<void> {
    clearInterval(this.ping);
    for (const s of this.streams.values()) s.end();
    this.streams.clear();
    const server = this.server;
    this.server = undefined;
    if (!server) return;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }

  diagnostics(): HubDiagnostics {
    return {
      role: 'hub',
      pid: process.pid,
      port: this.opts.port,
      version: this.opts.version,
      protocol: PROTOCOL_VERSION,
      hubWindowId: this.opts.localWindowId,
      startedAt: this.startedAt,
      windows: this.opts.router.windowList(),
      bindings: this.opts.router.bindingList(),
      received: this.received,
      rejected: { ...this.rejected },
      recent: [...this.recent],
    };
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    const rejection = checkRequest(req, this.opts.port, this.opts.token);
    if (rejection) {
      this.rejected[rejection.reason] = (this.rejected[rejection.reason] ?? 0) + 1;
      req.resume();
      res.writeHead(rejection.status).end();
      return;
    }
    const path = (req.url ?? '').split('?')[0];
    if (req.method === 'POST' && path === PATHS.hook) return void this.onHook(req, res);
    if (req.method === 'GET' && path === PATHS.health) {
      const health: Health = {
        app: 'cc-beacon',
        protocol: PROTOCOL_VERSION,
        version: this.opts.version,
        hubWindowId: this.opts.localWindowId,
        pid: process.pid,
      };
      return json(res, 200, health);
    }
    if (req.method === 'GET' && path === PATHS.diagnostics) return json(res, 200, this.diagnostics());
    const m = WINDOW_PATH.exec(path);
    if (m && req.method === 'POST' && m[2]) return void this.onStream(m[1], req, res);
    if (m && req.method === 'PUT' && !m[2]) return void this.onUpdate(m[1], req, res);
    req.resume();
    res.writeHead(404).end();
  }

  private async onHook(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const receivedAt = Date.now();
    const body = await this.readJson(req, res);
    if (body === undefined) return;
    // Answer before any processing: Claude Code waits for the hook to finish.
    res.writeHead(204).end();
    const ev = normalize(body, req.headers, receivedAt);
    if (!ev) {
      this.remember({ at: receivedAt, hook: 'invalid', session: '', dropped: 'no session_id' });
      return;
    }
    this.received++;
    // Routing can wait on a ps snapshot; keep each session's events in order.
    const prev = this.chains.get(ev.sessionKey) ?? Promise.resolve();
    const next = prev.then(async () => {
      const result = await this.opts.router.route(ev);
      const base: RecentEvent = {
        at: receivedAt,
        hook: ev.hook,
        type: ev.notificationType,
        session: ev.sessionKey,
        entrypoint: ev.entrypoint,
        detail: this.opts.includeMessageText?.() ? ev.detail : undefined,
      };
      if ('dropped' in result) {
        this.remember({ ...base, dropped: result.dropped });
        return;
      }
      const delivered = this.deliver(result.windowId, result.routed);
      this.remember({ ...base, windowId: result.windowId, via: result.routed.via, dropped: delivered ? undefined : 'window gone' });
    });
    const tail = next.catch((e) => this.opts.log(`routing failed: ${String(e)}`));
    this.chains.set(ev.sessionKey, tail);
    void tail.then(() => {
      if (this.chains.get(ev.sessionKey) === tail) this.chains.delete(ev.sessionKey);
    });
  }

  private async onStream(windowId: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const info = await this.readJson(req, res);
    if (info === undefined) return;
    if (!isWindowInfo(info)) return json(res, 400, { error: 'bad window info' });
    if (info.protocol !== PROTOCOL_VERSION) return json(res, 409, { error: 'protocol mismatch', protocol: PROTOCOL_VERSION });
    if (windowId === this.opts.localWindowId) return json(res, 409, { error: 'window id in use by the hub' });

    this.streams.get(windowId)?.end(); // a reloaded window reconnecting
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(': hello\n\n');
    this.streams.set(windowId, res);
    this.opts.router.upsertWindow({ ...info, windowId });
    this.opts.log(`window registered: ${windowId} (${info.name})`);
    res.on('close', () => {
      if (this.streams.get(windowId) !== res) return;
      this.streams.delete(windowId);
      this.opts.router.removeWindow(windowId);
      this.opts.log(`window left: ${windowId}`);
    });
  }

  private async onUpdate(windowId: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const info = await this.readJson(req, res);
    if (info === undefined) return;
    if (!isWindowInfo(info)) return json(res, 400, { error: 'bad window info' });
    if (!this.streams.has(windowId)) return json(res, 404, { error: 'unknown window' });
    this.opts.router.upsertWindow({ ...info, windowId });
    res.writeHead(204).end();
  }

  private deliver(windowId: string, routed: RoutedEvent): boolean {
    if (windowId === this.opts.localWindowId) {
      try {
        this.opts.onLocalEvent(routed);
      } catch (e) {
        this.opts.log(`local delivery failed: ${String(e)}`);
      }
      return true;
    }
    const stream = this.streams.get(windowId);
    if (!stream) return false;
    stream.write(`event: route\ndata: ${JSON.stringify(routed)}\n\n`);
    return true;
  }

  private broadcast(chunk: string): void {
    for (const s of this.streams.values()) s.write(chunk);
  }

  /** Reads and parses a JSON body. On failure it answers the request itself and returns undefined. */
  private async readJson(req: IncomingMessage, res: ServerResponse): Promise<unknown> {
    try {
      const buf = await readBody(req);
      return JSON.parse(buf.toString('utf8'));
    } catch (e) {
      const tooLarge = e instanceof BodyTooLarge;
      const reason = tooLarge ? 'too-large' : 'bad-json';
      this.rejected[reason] = (this.rejected[reason] ?? 0) + 1;
      if (!res.headersSent) res.writeHead(tooLarge ? 413 : 400).end();
      return undefined;
    }
  }

  private remember(e: RecentEvent): void {
    this.recent.push(e);
    if (this.recent.length > RECENT_MAX) this.recent.shift();
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) }).end(text);
}

function isWindowInfo(v: unknown): v is WindowInfo {
  if (typeof v !== 'object' || v === null) return false;
  const w = v as Partial<WindowInfo>;
  return (
    typeof w.protocol === 'number' &&
    typeof w.name === 'string' &&
    typeof w.extHostPid === 'number' &&
    Array.isArray(w.folders) &&
    w.folders.every((f) => typeof f === 'string') &&
    typeof w.focused === 'boolean' &&
    typeof w.active === 'boolean' &&
    typeof w.lastFocusedAt === 'number' &&
    Array.isArray(w.terminals) &&
    w.terminals.every((t) => typeof t?.shellPid === 'number' && typeof t?.name === 'string')
  );
}
