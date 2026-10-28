// Turns an alert into notification text (phase1-plan §5.1). Everything here is plain text.
import path from 'node:path';
import type { Alert } from './stateMachine';

export interface PresentSettings {
  includeMessage: boolean;
  maxChars: number;
}

export interface Presentation {
  title: string;
  subtitle: string;
  body?: string;
}

export function present(alert: Alert, project: string, settings: PresentSettings): Presentation {
  let title: string;
  let subtitle = project;
  switch (alert.kind) {
    case 'needs-input':
      if (alert.reason === 'question') title = 'Claude has a question';
      else if (alert.reason === 'permission') {
        title = 'Claude needs approval';
        if (alert.toolName) subtitle = `${project} · ${alert.toolName}`;
      } else title = 'Claude needs input';
      break;
    case 'completed':
      title = alert.endsWithQuestion
        ? 'Claude has a question'
        : alert.turnMs !== undefined && alert.turnMs >= 1000
          ? `Claude finished after ${formatDuration(alert.turnMs)}`
          : 'Claude finished';
      break;
    case 'failed':
      title = 'Claude stopped with an error';
      break;
    case 'reminder':
      title = 'Claude is waiting for you';
      break;
  }
  const body = settings.includeMessage && alert.detail ? cleanText(alert.detail, settings.maxChars) : undefined;
  return { title, subtitle, body: body || undefined };
}

/** Collapses whitespace, strips common Markdown markers and truncates with an ellipsis. */
export function cleanText(s: string, max: number): string {
  const text = s
    .replace(/```[a-z]*\n?/gi, '')
    .replace(/^\s{0,3}(#{1,6}|[-*+]|\d+\.|>)\s+/gm, '')
    .replace(/(\*\*|__|`)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(1, max - 1)).trimEnd()}…`;
}

export function formatDuration(ms: number): string {
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

/** The workspace folder's name if one matched, else the cwd's basename. */
export function projectLabel(folder: string | undefined, cwd: string | undefined): string {
  const p = folder ?? cwd;
  return p ? path.basename(p) || p : 'Claude Code';
}
