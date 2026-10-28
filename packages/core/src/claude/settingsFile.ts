// Reading and safely writing ~/.claude/settings.json: symlinks resolved (dotfiles), a timestamped
// backup (newest 5 kept), and an atomic temp-file + rename that keeps the file's mode.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BACKUPS_KEPT = 5;

export function claudeSettingsPath(env: NodeJS.ProcessEnv = process.env): string {
  const dir = env.CLAUDE_CONFIG_DIR?.trim() || path.join(os.homedir(), '.claude');
  return path.join(dir, 'settings.json');
}

export function readSettings(file: string): { text: string; exists: boolean } {
  try {
    return { text: fs.readFileSync(file, 'utf8'), exists: true };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { text: '', exists: false };
    throw e;
  }
}

/** Writes text to file; returns the backup path if there was an existing file to back up. */
export function writeSettings(file: string, text: string, now = new Date()): { backup?: string } {
  let target = file;
  let mode = 0o644;
  let backup: string | undefined;
  if (fs.existsSync(file)) {
    target = fs.realpathSync(file); // write through a symlink instead of replacing it
    mode = fs.statSync(target).mode & 0o777;
    const stamp = now.toISOString().replace(/[:.]/g, '-');
    backup = `${target}.cc-beacon-${stamp}.bak`;
    fs.copyFileSync(target, backup);
    pruneBackups(target);
  } else {
    fs.mkdirSync(path.dirname(target), { recursive: true });
  }
  const tmp = `${target}.cc-beacon-${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, text, { mode });
    fs.chmodSync(tmp, mode);
    fs.renameSync(tmp, target);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  return { backup };
}

function pruneBackups(target: string): void {
  const dir = path.dirname(target);
  const prefix = `${path.basename(target)}.cc-beacon-`;
  const backups = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith(prefix) && f.endsWith('.bak'))
    .sort();
  for (const f of backups.slice(0, Math.max(0, backups.length - BACKUPS_KEPT))) fs.rmSync(path.join(dir, f), { force: true });
}
