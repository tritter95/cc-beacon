// Request checks for the loopback server (PLAN §6): loopback peer, exact Host, no Origin (blocks
// browser CSRF and DNS rebinding), JSON bodies with a size cap, and the per-user token.
import type { IncomingMessage } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { MAX_BODY_BYTES } from './protocol';
import { HEADER } from '../claude/normalize';

export type RejectReason = 'peer' | 'host' | 'origin' | 'token' | 'content-type' | 'too-large';

export interface Rejection {
  status: number;
  reason: RejectReason;
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export function checkRequest(req: IncomingMessage, port: number, token: string): Rejection | null {
  if (!LOOPBACK.has(req.socket.remoteAddress ?? '')) return { status: 403, reason: 'peer' };
  const host = req.headers.host;
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return { status: 403, reason: 'host' };
  if (req.headers.origin !== undefined) return { status: 403, reason: 'origin' };
  if (!tokenMatches(req.headers[HEADER.token], token)) return { status: 401, reason: 'token' };
  if (req.method === 'POST' || req.method === 'PUT') {
    const type = req.headers['content-type'] ?? '';
    if (!/^application\/json\b/i.test(type)) return { status: 415, reason: 'content-type' };
    const length = Number(req.headers['content-length'] ?? 0);
    if (length > MAX_BODY_BYTES) return { status: 413, reason: 'too-large' };
  }
  return null;
}

export function tokenMatches(given: string | string[] | undefined, expected: string): boolean {
  const g = Buffer.from(Array.isArray(given) ? (given[0] ?? '') : (given ?? ''));
  const e = Buffer.from(expected);
  return g.length === e.length && e.length > 0 && timingSafeEqual(g, e);
}

export class BodyTooLarge extends Error {}

/** Reads a request body, failing once it exceeds max bytes (Content-Length can be absent or wrong). */
export function readBody(req: IncomingMessage, max = MAX_BODY_BYTES): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > max) {
        reject(new BodyTooLarge());
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
