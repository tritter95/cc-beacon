// In-window alert sounds on macOS: system sounds played with afplay. Sounds that accompany an
// OS notification are played by the notification itself, so Focus/DND can silence them.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { OkResult, PlaySoundRequest } from '../../shared/src/notifierApi';

export const SYSTEM_SOUNDS_DIR = '/System/Library/Sounds';
const AFPLAY = '/usr/bin/afplay';
const SOUND_NAME = /^[A-Za-z0-9 _-]+$/;

/** The .aiff for a system sound name, or undefined if the name is invalid or unknown. */
export function systemSoundPath(name: string, exists: (p: string) => boolean = fs.existsSync): string | undefined {
  if (!SOUND_NAME.test(name)) return undefined;
  const file = path.join(SYSTEM_SOUNDS_DIR, `${name}.aiff`);
  return exists(file) ? file : undefined;
}

export function afplayArgs(file: string, volume: number): string[] {
  const v = Number.isFinite(volume) ? Math.min(1, Math.max(0, volume)) : 1;
  return ['-v', v.toFixed(2), file];
}

/** Starts playback and resolves once afplay is running; it doesn't wait for the sound to end. */
export function playSystemSound(req: PlaySoundRequest): Promise<OkResult> {
  if (!req.name || req.name === 'none') return Promise.resolve({ ok: true });
  const file = systemSoundPath(req.name);
  if (!file) return Promise.resolve({ ok: false, error: `Unknown sound "${req.name}"` });
  return new Promise((resolve) => {
    const child = spawn(AFPLAY, afplayArgs(file, req.volume), { stdio: 'ignore' });
    child.once('spawn', () => {
      child.unref();
      resolve({ ok: true });
    });
    child.once('error', (err) => resolve({ ok: false, error: err.message }));
  });
}
