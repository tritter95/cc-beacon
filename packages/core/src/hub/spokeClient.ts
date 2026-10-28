// A spoke window's connection to the hub: one long-lived POST whose response is an SSE stream of
// the events routed to this window. The registration lives exactly as long as the stream.
import http from 'node:http';
import { HEADER } from '../claude/normalize';
import type { RoutedEvent, WindowInfo } from '../model';
import { PATHS } from './protocol';

export interface HubResponse {
  status: number;
  body?: unknown;
}

/** A small JSON request to the hub. Resolves with status 0 when nothing answers. */
export function hubRequest(
  port: number,
  token: string,
  method: string,
  path: string,
  body?: unknown,
  timeoutMs = 1000,
): Promise<HubResponse> {
  return new Promise((resolve) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path,
        agent: false,
        timeout: timeoutMs,
        headers: {
          [HEADER.token]: token,
          ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let parsed: unknown;
          try {
            parsed = text ? JSON.parse(text) : undefined;
          } catch {
            parsed = text;
          }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve({ status: 0 }));
    req.end(data);
  });
}

export interface SpokeOptions {
  port: number;
  token: string;
  windowId: string;
  onEvent: (r: RoutedEvent) => void;
  /** The stream ended after it was established (hub went away). Not called after close(). */
  onClose: (reason: string) => void;
  log: (msg: string) => void;
}

export class SpokeClient {
  private req?: http.ClientRequest;
  private connected = false;
  private closed = false;
  private finished = false;

  constructor(private readonly opts: SpokeOptions) {}

  connect(info: WindowInfo): Promise<void> {
    const { port, token, windowId } = this.opts;
    const data = JSON.stringify(info);
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          method: 'POST',
          path: `${PATHS.windows}${windowId}/stream`,
          agent: false,
          headers: { [HEADER.token]: token, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
        },
        (res) => {
          if (res.statusCode !== 200) {
            res.resume();
            reject(new Error(`hub refused the stream: HTTP ${res.statusCode}`));
            return;
          }
          this.connected = true;
          resolve();
          res.setEncoding('utf8');
          let buf = '';
          res.on('data', (chunk: string) => {
            buf += chunk;
            for (let i = buf.indexOf('\n\n'); i >= 0; i = buf.indexOf('\n\n')) {
              this.onFrame(buf.slice(0, i));
              buf = buf.slice(i + 2);
            }
          });
          res.on('close', () => this.finish('stream closed'));
        },
      );
      req.on('error', (e) => {
        if (!this.connected) reject(e);
        this.finish(e.message);
      });
      req.setNoDelay(true);
      req.end(data);
      this.req = req;
    });
  }

  update(info: WindowInfo): void {
    if (!this.connected || this.closed) return;
    void hubRequest(this.opts.port, this.opts.token, 'PUT', `${PATHS.windows}${this.opts.windowId}`, info).then((r) => {
      if (r.status === 404) {
        // The hub forgot us (it restarted between our stream closing and this update): reconnect.
        this.req?.destroy();
      }
    });
  }

  close(): void {
    this.closed = true;
    this.req?.destroy();
  }

  private onFrame(frame: string): void {
    let event = 'message';
    const data: string[] = [];
    for (const line of frame.split('\n')) {
      if (line.startsWith(':')) continue;
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
    }
    if (event !== 'route' || data.length === 0) return;
    try {
      this.opts.onEvent(JSON.parse(data.join('\n')) as RoutedEvent);
    } catch (e) {
      this.opts.log(`bad routed event: ${String(e)}`);
    }
  }

  private finish(reason: string): void {
    if (this.finished) return;
    this.finished = true;
    if (this.connected && !this.closed) this.opts.onClose(reason);
  }
}
