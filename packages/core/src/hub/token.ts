// The per-user token (PLAN §6, phase1-plan D5). It lives in ~/.cc-beacon/token; the hook reads it
// from ~/.cc-beacon/hook-header with curl's -H @file, so ~/.claude/settings.json holds no secret.
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const HOOK_HEADER_FILE = 'hook-header';

export function beaconDir(home = os.homedir()): string {
  return path.join(home, '.cc-beacon');
}

export interface Secrets {
  token: string;
  dir: string;
  headerFile: string;
}

/** Creates the token once per user. Safe when several windows activate at the same moment. */
export function ensureSecrets(dir = beaconDir()): Secrets {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tokenFile = path.join(dir, 'token');
  let token = readToken(tokenFile);
  if (!token) {
    // Write to a private temp file, then hard-link it into place: link() fails if another window
    // got there first, and readers never see a half-written token.
    const tmp = path.join(dir, `token.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
    fs.writeFileSync(tmp, randomBytes(24).toString('hex'), { mode: 0o600 });
    try {
      fs.linkSync(tmp, tokenFile);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    } finally {
      fs.rmSync(tmp, { force: true });
    }
    token = readToken(tokenFile);
    if (!token) throw new Error(`Unreadable token in ${tokenFile}`);
  }
  const headerFile = path.join(dir, HOOK_HEADER_FILE);
  writeIfChanged(headerFile, `X-CC-Beacon-Token: ${token}\n`);
  return { token, dir, headerFile };
}

function readToken(file: string): string | undefined {
  try {
    const t = fs.readFileSync(file, 'utf8').trim();
    return /^[0-9a-f]{32,}$/.test(t) ? t : undefined;
  } catch {
    return undefined;
  }
}

function writeIfChanged(file: string, content: string): void {
  try {
    if (fs.readFileSync(file, 'utf8') === content) return;
  } catch {
    // missing: write it
  }
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content, { mode: 0o600 });
  fs.renameSync(tmp, file);
}
