// Integrated terminals and their shell PIDs. The hub matches a Claude process's parent against
// these PIDs (Phase 0 row 4b), and "watching" compares the active terminal with the session's.
import * as vscode from 'vscode';

const CLAUDE_COMMAND = /^\s*(npx\s+\S*claude\S*|claude)\b/;

export class TerminalTracker implements vscode.Disposable {
  private pids = new Map<vscode.Terminal, number>();
  private claude = new Set<vscode.Terminal>();
  private lastFocused = new Map<vscode.Terminal, number>();
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  private readonly subs: vscode.Disposable[] = [];

  constructor() {
    for (const t of vscode.window.terminals) this.add(t);
    this.subs.push(
      this.changed,
      vscode.window.onDidOpenTerminal((t) => this.add(t)),
      vscode.window.onDidCloseTerminal((t) => {
        this.pids.delete(t);
        this.claude.delete(t);
        this.lastFocused.delete(t);
        this.changed.fire();
      }),
      vscode.window.onDidChangeActiveTerminal((t) => {
        if (t) this.lastFocused.set(t, Date.now());
      }),
      vscode.window.onDidStartTerminalShellExecution((e) => {
        if (CLAUDE_COMMAND.test(e.execution.commandLine.value)) this.claude.add(e.terminal);
      }),
      vscode.window.onDidEndTerminalShellExecution((e) => {
        if (CLAUDE_COMMAND.test(e.execution.commandLine.value)) this.claude.delete(e.terminal);
      }),
    );
  }

  terminals(): { shellPid: number; name: string }[] {
    return [...this.pids].map(([t, shellPid]) => ({ shellPid, name: t.name }));
  }

  byPid(pid: number | undefined): vscode.Terminal | undefined {
    if (pid === undefined) return undefined;
    for (const [t, p] of this.pids) if (p === pid) return t;
    return undefined;
  }

  pidOf(t: vscode.Terminal | undefined): number | undefined {
    return t ? this.pids.get(t) : undefined;
  }

  /** Terminals currently running `claude` (needs shell integration). */
  claudeTerminals(): vscode.Terminal[] {
    return [...this.claude];
  }

  dispose(): void {
    for (const s of this.subs) s.dispose();
  }

  private add(t: vscode.Terminal): void {
    void t.processId.then((pid) => {
      if (pid === undefined || !vscode.window.terminals.includes(t)) return;
      this.pids.set(t, pid);
      this.changed.fire();
    });
  }
}
