// Where you are relative to a session (PLAN §4.4): L0 watching it, L1 elsewhere in VS Code,
// L2 away from the window, L3 focused but idle. Unknowns bias toward alerting (L1 over L0).
import * as vscode from 'vscode';
import type { TerminalTracker } from '../routing/terminalTracker';
import type { Level } from './stateMachine';

export interface SessionPlace {
  entrypoint?: string;
  terminalShellPid?: number;
}

const PANEL_VIEW_TYPE = 'claudeVSCodePanel';

export class AttentionContext implements vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  /** Fires when focus, activity, the active terminal or the active tab changes. */
  readonly onDidChange = this.changed.event;
  private readonly subs: vscode.Disposable[];

  constructor(private readonly tracker: TerminalTracker) {
    const fire = () => this.changed.fire();
    this.subs = [
      this.changed,
      vscode.window.onDidChangeWindowState(fire),
      vscode.window.onDidChangeActiveTerminal(fire),
      vscode.window.tabGroups.onDidChangeTabs(fire),
      vscode.window.tabGroups.onDidChangeTabGroups(fire),
      tracker.onDidChange(fire),
    ];
  }

  level(s: SessionPlace): Level {
    const state = vscode.window.state;
    if (!state.focused) return 2;
    if (!state.active) return 3;
    return this.watching(s) ? 0 : 1;
  }

  watching(s: SessionPlace): boolean {
    if (s.entrypoint === 'claude-vscode') {
      const panels = vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter(isClaudePanel);
      // With several Claude tabs we can't tell which session the active one shows.
      return panels.length === 1 && panels[0].isActive && panels[0].group.isActive;
    }
    const pid = this.tracker.pidOf(vscode.window.activeTerminal);
    return pid !== undefined && pid === s.terminalShellPid;
  }

  dispose(): void {
    for (const s of this.subs) s.dispose();
  }
}

function isClaudePanel(tab: vscode.Tab): boolean {
  return tab.input instanceof vscode.TabInputWebview && tab.input.viewType.includes(PANEL_VIEW_TYPE);
}
