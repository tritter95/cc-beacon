// Brings a session forward: its terminal, or its Claude panel tab (phase1-plan §5.5).
import * as vscode from 'vscode';
import type { Entry } from '../attention/sessionStore';
import type { TerminalTracker } from '../routing/terminalTracker';
import { byUrgency, preview, project, stateIcon, stateText, where } from './labels';

export async function revealSession(e: Entry, tracker: TerminalTracker, log: (m: string) => void): Promise<boolean> {
  if (e.s.entrypoint === 'claude-vscode') {
    // What the Claude extension's own vscode://anthropic.claude-code/open?session= runs. It reveals
    // the session's open tab (or sidebar) and only opens a new tab when the session isn't shown.
    try {
      await vscode.commands.executeCommand('claude-vscode.primaryEditor.open', e.key);
      return true;
    } catch (err) {
      log(`claude-vscode.primaryEditor.open failed: ${String(err)}`);
      try {
        await vscode.commands.executeCommand('claude-vscode.focus');
        return true;
      } catch {
        return false;
      }
    }
  }
  const claudeTerminals = tracker.claudeTerminals();
  const terminal = tracker.byPid(e.terminalShellPid) ?? (claudeTerminals.length === 1 ? claudeTerminals[0] : undefined);
  if (!terminal) return false;
  terminal.show(false);
  return true;
}

export async function pickSession(entries: Entry[]): Promise<Entry | undefined> {
  if (entries.length === 0) {
    void vscode.window.showInformationMessage('CC Beacon: no Claude sessions in this window yet.');
    return undefined;
  }
  const items = [...entries].sort(byUrgency).map((e) => ({
    label: `${stateIcon(e)} ${project(e)}`,
    description: `${stateText(e)} · ${where(e)}`,
    detail: preview(e),
    entry: e,
  }));
  const pick = await vscode.window.showQuickPick(items, {
    title: 'Claude sessions in this window',
    placeHolder: 'Select a session to show it',
    matchOnDescription: true,
    matchOnDetail: true,
  });
  return pick?.entry;
}
