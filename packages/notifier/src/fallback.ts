// Last-resort macOS delivery through `osascript display notification`. It is attributed to
// Script Editor and has no click action, so it is used only when the helper can't run (D10).
// Notification text travels as arguments to the run handler and is never part of the script.
import type { NotifyRequest, OkResult } from '../../shared/src/notifierApi';
import { describeFailure, run } from './exec';

export const OSASCRIPT = '/usr/bin/osascript';

export const OSASCRIPT_LINES = [
  'on run argv',
  'set theTitle to item 1 of argv',
  'set theSubtitle to item 2 of argv',
  'set theBody to item 3 of argv',
  'set theSound to item 4 of argv',
  'if theSound is "" then',
  'if theSubtitle is "" then',
  'display notification theBody with title theTitle',
  'else',
  'display notification theBody with title theTitle subtitle theSubtitle',
  'end if',
  'else',
  'if theSubtitle is "" then',
  'display notification theBody with title theTitle sound name theSound',
  'else',
  'display notification theBody with title theTitle subtitle theSubtitle sound name theSound',
  'end if',
  'end if',
  'end run',
];

const SOUND_NAME = /^[A-Za-z0-9 _-]+$/;

/** `--` ends osascript's options, so text starting with "-" isn't read as a flag. */
export function osascriptArgs(req: NotifyRequest): string[] {
  const args: string[] = [];
  for (const line of OSASCRIPT_LINES) args.push('-e', line);
  const sound = req.sound && req.sound !== 'none' && req.sound !== 'default' && SOUND_NAME.test(req.sound) ? req.sound : '';
  args.push('--', req.title, req.subtitle ?? '', req.body ?? '', sound);
  return args;
}

export async function postWithOsascript(req: NotifyRequest, timeoutMs = 5000): Promise<OkResult> {
  const r = await run(OSASCRIPT, osascriptArgs(req), timeoutMs);
  return r.code === 0 ? { ok: true } : { ok: false, error: describeFailure(r) };
}
