// Hub ⇄ spoke protocol (phase1-plan §5.3). Every window runs the same code; the one that wins the
// port is the hub, the others are spokes that receive their routed events over SSE.
import { createHash } from 'node:crypto';

export const PROTOCOL_VERSION = 1;
export const API = '/cc-beacon/v1';
export const PATHS = {
  hook: `${API}/hook`,
  health: `${API}/health`,
  diagnostics: `${API}/diagnostics`,
  /** POST {API}/windows/:id/stream registers a window and returns its SSE stream; PUT {API}/windows/:id updates it. */
  windows: `${API}/windows/`,
} as const;

export const MAX_BODY_BYTES = 1024 * 1024;
export const BASE_PORT = 48812; // 0xBEAC
export const PING_INTERVAL_MS = 15_000;

export interface Health {
  app: 'cc-beacon';
  protocol: number;
  version: string;
  hubWindowId: string;
  pid: number;
}

/** Default port: 48812 plus a per-user offset, so users on a shared host don't collide. */
export function defaultPort(uid: number | undefined, username: string): number {
  if (uid !== undefined && uid >= 0) return BASE_PORT + (uid % 100);
  const h = createHash('sha1').update(username.toLowerCase()).digest();
  return BASE_PORT + (h.readUInt16BE(0) % 100);
}
