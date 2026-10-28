// "CC Beacon: Diagnose" (phase1-plan §5.6): a Markdown report that can be pasted into a bug
// report. Message text is left out unless the user opted in.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import type { Capabilities } from '../../shared/src/notifierApi';
import type { Entry } from './attention/sessionStore';
import type { HookState } from './claude/hookInstaller';
import type { HubDiagnostics } from './hub/server';
import { project, stateText, where } from './ui/labels';

export const MIN_CLAUDE_VERSION = '2.1.233';
const MANAGED_SETTINGS = '/Library/Application Support/ClaudeCode/managed-settings.json';

export class LatencyStats {
  private samples: number[] = [];

  add(ms: number): void {
    this.samples.push(ms);
    if (this.samples.length > 500) this.samples.shift();
  }

  summary(): { n: number; p50?: number; p95?: number; max?: number } {
    const s = [...this.samples].sort((a, b) => a - b);
    if (s.length === 0) return { n: 0 };
    const at = (q: number) => s[Math.min(s.length - 1, Math.ceil(q * s.length) - 1)];
    return { n: s.length, p50: at(0.5), p95: at(0.95), max: s[s.length - 1] };
  }
}

export interface ReportInput {
  generatedAt: Date;
  versions: { vscode: string; core: string; notifier?: string; claude?: string };
  hub: { role: string; detail?: string; port: number; windowId: string; envWindow?: string; diagnostics?: HubDiagnostics };
  hooks: HookState;
  managed?: { file: string; flags: string[] };
  notifier: { caps?: Capabilities; missing: boolean };
  entries: Entry[];
  latency: ReturnType<LatencyStats['summary']>;
  muted: boolean;
}

export function renderReport(r: ReportInput): string {
  const L: string[] = [];
  const row = (...cells: (string | number | undefined)[]) => L.push(`| ${cells.map((c) => cell(c)).join(' | ')} |`);

  L.push('# CC Beacon diagnostics', '', `Generated ${r.generatedAt.toISOString()}`, '');

  L.push('## Versions', '');
  L.push(`- VS Code ${r.versions.vscode}`);
  L.push(`- CC Beacon ${r.versions.core}, Notifier ${r.versions.notifier ?? '**not installed**'}`);
  const claude = r.versions.claude;
  L.push(`- Claude Code ${claude ?? 'not found on PATH'}${claude && older(claude, MIN_CLAUDE_VERSION) ? ` ⚠️ older than ${MIN_CLAUDE_VERSION}` : ''}`);
  L.push('');

  const h = r.hub;
  L.push('## Hub', '');
  L.push(`- This window: **${h.role}**${h.detail ? ` (${h.detail})` : ''}, id \`${h.windowId}\`, port ${h.port}`);
  L.push(`- CC_BEACON_WINDOW in this extension host: ${h.envWindow === h.windowId ? 'set' : `**${h.envWindow ?? 'missing'}**`}`);
  const d = h.diagnostics;
  if (d) {
    L.push(`- Hub pid ${d.pid}, version ${d.version}, protocol ${d.protocol}, up since ${new Date(d.startedAt).toISOString()}`);
    L.push(`- Events received: ${d.received}. Rejected requests: ${fmtCounts(d.rejected)}`);
    L.push('', '| Window | Id | Folders | Terminals | Focused |', '|---|---|---|---|---|');
    for (const w of d.windows) row(w.name, w.windowId === d.hubWindowId ? `${w.windowId} (hub)` : w.windowId, w.folders.length, w.terminals.length, w.focused ? 'yes' : '');
  } else {
    L.push('- Hub diagnostics unavailable');
  }
  L.push('');

  const k = r.hooks;
  L.push('## Claude Code hooks', '');
  L.push(`- ${k.file}: ${k.exists ? `**${k.status}**` : '**missing file**'}${k.error ? ` (${k.error})` : ''}`);
  if (k.missing.length) L.push(`- Missing: ${k.missing.join(', ')}`);
  if (k.outdated.length) L.push(`- Outdated: ${k.outdated.join(', ')}`);
  if (k.disableAllHooks) L.push('- ⚠️ `disableAllHooks` is on: no hooks run');
  if (r.managed) L.push(`- Managed settings ${r.managed.file}${r.managed.flags.length ? `: ⚠️ ${r.managed.flags.join(', ')}` : ' (no hook restrictions)'}`);
  L.push('');

  L.push('## Notifications', '');
  const c = r.notifier.caps;
  if (r.notifier.missing || !c) L.push('- Notifier unreachable: alerts stay inside VS Code');
  else {
    L.push(`- Methods: ${c.methods.length ? c.methods.join(', ') : 'none (in-window only)'}`);
    L.push(`- Permission: ${c.permission}${c.alertStyle ? `, alert style ${c.alertStyle}` : ''}${c.helperVersion ? `, helper ${c.helperVersion}` : ''}`);
    for (const p of c.problems ?? []) L.push(`- ⚠️ ${p}`);
  }
  if (r.muted) L.push('- Muted');
  const lat = r.latency;
  L.push(`- Latency, hook received → notification posted: ${lat.n ? `p50 ${lat.p50} ms, p95 ${lat.p95} ms, max ${lat.max} ms (n=${lat.n})` : 'no samples yet'}`);
  L.push('');

  L.push('## Sessions in this window', '');
  if (r.entries.length === 0) L.push('None.');
  else {
    L.push('| Session | Project | Where | State | Unacknowledged | Terminal pid |', '|---|---|---|---|---|---|');
    for (const e of r.entries) row(e.key.slice(0, 8), project(e), where(e), stateText(e), e.s.attention?.kind ?? '', e.terminalShellPid);
  }
  L.push('');

  if (d?.recent.length) {
    L.push('## Recent hook events (hub)', '', '| Time | Event | Session | Entrypoint | Window | Via | Dropped |', '|---|---|---|---|---|---|---|');
    for (const e of d.recent.slice(-20)) {
      row(new Date(e.at).toISOString().slice(11, 23), e.type ? `${e.hook} (${e.type})` : e.hook, e.session.slice(0, 8), e.entrypoint, e.windowId, e.via, e.dropped);
    }
    L.push('');
  }
  return L.join('\n');
}

export function claudeVersion(): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile('claude', ['--version'], { timeout: 5000 }, (err, stdout) => resolve(err ? undefined : /\d+\.\d+\.\d+/.exec(stdout)?.[0]));
  });
}

/** Managed settings that would stop our hooks (ADR 0001, corporate machines). */
export function managedSettings(file = MANAGED_SETTINGS): { file: string; flags: string[] } | undefined {
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    return { file, flags: ['allowManagedHooksOnly', 'disableAllHooks'].filter((k) => v[k] === true) };
  } catch {
    return undefined;
  }
}

export function older(version: string, min: string): boolean {
  const a = version.split('.').map(Number);
  const b = min.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) < (b[i] ?? 0);
  return false;
}

function cell(v: string | number | undefined): string {
  return v === undefined || v === '' ? '' : String(v).replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function fmtCounts(c: Record<string, number | undefined>): string {
  const parts = Object.entries(c).filter(([, n]) => n);
  return parts.length ? parts.map(([k, n]) => `${k} ${n}`).join(', ') : 'none';
}
