// Mute is per machine (phase1-plan D12): stored in globalState and read at alert time.
import * as vscode from 'vscode';

const KEY = 'ccBeacon.mutedUntil';

export class Mute implements vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  private timer?: NodeJS.Timeout;

  constructor(private readonly state: vscode.Memento) {
    this.schedule();
  }

  get until(): number {
    return this.state.get<number>(KEY, 0);
  }

  get muted(): boolean {
    return this.until > Date.now();
  }

  async mute(ms: number): Promise<void> {
    await this.state.update(KEY, Date.now() + ms);
    this.schedule();
    this.changed.fire();
  }

  async unmute(): Promise<void> {
    await this.state.update(KEY, 0);
    this.schedule();
    this.changed.fire();
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.changed.dispose();
  }

  private schedule(): void {
    clearTimeout(this.timer);
    void vscode.commands.executeCommand('setContext', 'ccBeacon.muted', this.muted);
    const left = this.until - Date.now();
    if (left > 0) this.timer = setTimeout(() => this.schedule(), Math.min(left + 50, 2 ** 31 - 1));
    else if (left > -1000) this.changed.fire();
  }
}
