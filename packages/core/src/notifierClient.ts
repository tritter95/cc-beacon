// Core's side of the Notifier contract. Core never depends on the Notifier extension (VS Code
// would try to fetch it from the Marketplace); it probes for it and degrades to in-window alerts.
import * as vscode from 'vscode';
import {
  NotifierCommand,
  type Capabilities,
  type NotifyRequest,
  type NotifyResult,
  type Permission,
} from '../../shared/src/notifierApi';

export class NotifierClient {
  caps?: Capabilities;
  /** Set when the Notifier couldn't be reached at all. */
  missing = false;

  constructor(private readonly log: (m: string) => void) {}

  async probe(): Promise<Capabilities | undefined> {
    try {
      this.caps = await call<Capabilities>(NotifierCommand.capabilities, undefined, 4000);
      this.missing = false;
    } catch (e) {
      this.caps = undefined;
      this.missing = true;
      this.log(`notifier unavailable: ${String(e)}`);
    }
    return this.caps;
  }

  async notify(req: NotifyRequest): Promise<NotifyResult> {
    try {
      const r = await call<NotifyResult>(NotifierCommand.notify, req, 6000);
      if (!r.delivered && (r.error === 'notDetermined' || r.error === 'denied') && this.caps) {
        this.caps = { ...this.caps, permission: r.error, methods: [] };
      }
      return r;
    } catch (e) {
      this.missing = true;
      return { delivered: false, ms: 0, error: String(e) };
    }
  }

  withdraw(threadId: string): void {
    void call(NotifierCommand.withdraw, { threadId }, 4000).catch(() => {});
  }

  playSound(name: string, volume: number): void {
    if (name === 'none' || volume <= 0) return;
    void call(NotifierCommand.playSound, { name, volume }, 4000).catch(() => {});
  }

  async requestPermission(): Promise<Permission> {
    const r = await call<{ permission: Permission }>(NotifierCommand.requestPermission, undefined, 130_000);
    await this.probe();
    return r.permission;
  }

  openSettings(): void {
    void call(NotifierCommand.openSettings, undefined, 4000).catch(() => {});
  }
}

function call<T>(command: string, arg: unknown, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${command} timed out`)), timeoutMs);
    const run = arg === undefined ? vscode.commands.executeCommand<T>(command) : vscode.commands.executeCommand<T>(command, arg);
    run.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}
