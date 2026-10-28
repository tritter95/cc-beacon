// Shared wording and icons for the status bar, tooltip and session picker.
import { cleanText, formatDuration, projectLabel } from '../attention/present';
import type { Entry } from '../attention/sessionStore';

export function stateText(e: Entry): string {
  const s = e.s;
  switch (s.state) {
    case 'needs-input':
      return s.reason === 'question' ? 'has a question' : s.reason === 'permission' ? 'needs approval' : 'needs input';
    case 'working':
      return 'working';
    case 'done':
      return s.lastTurnMs !== undefined && s.lastTurnMs >= 1000 ? `finished after ${formatDuration(s.lastTurnMs)}` : 'finished';
    case 'failed':
      return 'stopped with an error';
    case 'idle':
      return 'idle';
  }
}

export function stateIcon(e: Entry): string {
  if (e.s.state === 'needs-input') return '$(bell-dot)';
  if (e.s.state === 'failed') return '$(error)';
  if (e.s.state === 'working') return '$(sync~spin)';
  if (e.s.state === 'done') return '$(check)';
  return '$(circle-outline)';
}

export function project(e: Entry): string {
  return projectLabel(e.folder, e.s.cwd);
}

export function where(e: Entry): string {
  return e.s.entrypoint === 'claude-vscode' ? 'panel' : 'terminal';
}

export function preview(e: Entry, max = 100): string | undefined {
  return e.s.detail ? cleanText(e.s.detail, max) : undefined;
}

export function ago(ms: number, now = Date.now()): string {
  const d = Math.max(0, now - ms);
  return d < 60_000 ? 'just now' : `${formatDuration(d).split(' ')[0]} ago`;
}

/** Sessions that want you first, then most recent. */
export function byUrgency(a: Entry, b: Entry): number {
  const rank = (e: Entry) => (e.s.attention ? (e.s.state === 'needs-input' ? 0 : 1) : 2);
  return rank(a) - rank(b) || b.s.updatedAt - a.s.updatedAt;
}
