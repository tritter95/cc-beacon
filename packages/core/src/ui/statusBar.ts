// One status bar item per window: what this window's Claude sessions need, at a glance (PLAN §4.7).
import * as vscode from 'vscode';
import type { Entry } from '../attention/sessionStore';
import { ago, byUrgency, preview, project, stateIcon, stateText, where } from './labels';

export interface StatusModel {
  entries: Entry[];
  muted: boolean;
  mutedUntil: number;
  /** Something the user should fix (port in use, hooks missing, notifications off). */
  problem?: string;
}

export class StatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;

  constructor() {
    this.item = vscode.window.createStatusBarItem('ccBeacon.status', vscode.StatusBarAlignment.Right, 100);
    this.item.name = 'CC Beacon';
    this.item.command = 'ccBeacon.showSessions';
    this.item.show();
  }

  /** What the item shows right now. The integration test reads it. */
  get text(): string {
    return this.item.text;
  }

  render(m: StatusModel): void {
    const count = (pred: (e: Entry) => boolean) => m.entries.filter(pred).length;
    const needs = count((e) => e.s.attention !== undefined && e.s.state === 'needs-input');
    const failed = count((e) => e.s.attention?.kind === 'failed');
    const done = count((e) => e.s.attention !== undefined && e.s.state === 'done');
    const working = count((e) => e.s.state === 'working');

    const parts: string[] = [];
    let background: vscode.ThemeColor | undefined;
    let label: string;
    if (needs > 0) {
      parts.push(`$(bell-dot) ${needs}`);
      background = new vscode.ThemeColor('statusBarItem.warningBackground');
      label = `${needs} Claude ${needs === 1 ? 'session needs' : 'sessions need'} you`;
    } else if (failed > 0) {
      parts.push(`$(error) ${failed}`);
      background = new vscode.ThemeColor('statusBarItem.errorBackground');
      label = `${failed} Claude ${failed === 1 ? 'session' : 'sessions'} stopped with an error`;
    } else if (done > 0) {
      parts.push(`$(check) ${done}`);
      label = `${done} Claude ${done === 1 ? 'session' : 'sessions'} finished`;
    } else if (working > 0) {
      parts.push('$(sync~spin)');
      label = `Claude is working`;
    } else {
      parts.push(m.muted ? '$(bell-slash)' : '$(bell)');
      label = m.muted ? 'CC Beacon is muted' : 'CC Beacon';
    }
    if (m.muted && parts[0] !== '$(bell-slash)') parts.unshift('$(bell-slash)');
    if (m.problem) parts.push('$(warning)');

    this.item.text = parts.join(' ');
    this.item.backgroundColor = background;
    this.item.accessibilityInformation = { label: m.problem ? `${label}. ${m.problem}` : label };
    this.item.tooltip = tooltip(m);
  }

  dispose(): void {
    this.item.dispose();
  }
}

function tooltip(m: StatusModel): vscode.MarkdownString {
  const md = new vscode.MarkdownString(undefined, true);
  md.isTrusted = { enabledCommands: ['ccBeacon.diagnose', 'ccBeacon.unmute', 'ccBeacon.showSessions'] };
  md.appendMarkdown('**CC Beacon**');
  if (m.muted) md.appendMarkdown(` · muted until ${new Date(m.mutedUntil).toLocaleTimeString()} ([Unmute](command:ccBeacon.unmute))`);
  md.appendMarkdown('\n\n');
  if (m.problem) md.appendMarkdown(`$(warning) ${escape(m.problem)} ([Diagnose](command:ccBeacon.diagnose))\n\n`);
  const entries = [...m.entries].sort(byUrgency);
  if (entries.length === 0) md.appendMarkdown('No Claude sessions in this window yet.');
  for (const e of entries.slice(0, 8)) {
    const text = preview(e, 80);
    md.appendMarkdown(`${stateIcon(e)} **${escape(project(e))}** (${where(e)}) ${stateText(e)} · ${ago(e.s.updatedAt)}`);
    if (text) md.appendMarkdown(`  \n${escape(text)}`);
    md.appendMarkdown('\n\n');
  }
  return md;
}

function escape(s: string): string {
  return s.replace(/[\\`*_{}[\]()#+\-.!|<>]/g, '\\$&');
}
