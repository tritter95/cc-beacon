// A window id that is stable across reloads, so the persistent CC_BEACON_WINDOW in restored
// terminals still matches: a hash of the remote authority and the workspace (PLAN §4.2).
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';

export function computeWindowId(remoteAuthority: string | undefined, workspaceFile: string | undefined, folders: string[]): string {
  const key = workspaceFile ?? (folders.length ? [...folders].sort().join('\n') : undefined);
  // Empty windows have nothing stable to hash; their older terminals still route via CLAUDE_PID ancestry.
  if (key === undefined) return `empty-${randomBytes(6).toString('hex')}`;
  return createHash('sha256').update(`${remoteAuthority ?? ''}\n${key}`).digest('hex').slice(0, 16);
}

/** Claude reports a realpath cwd (/private/tmp/...), VS Code may hold /tmp/... (phase1-plan D16). */
export function realpathOr(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return p;
  }
}
