// The sessions this window owns. Feeds routed events, timers and acknowledgments through the state
// machine and carries out its effects. Has no vscode import: the window wires in UI and context.
import type { RoutedEvent } from '../model';
import { reduce, type Alert, type Effect, type Input, type Level, type Session } from './stateMachine';

/** Watching a session for this long acknowledges its alert (PLAN §4.3). */
export const FOCUS_ACK_MS = 1500;

export interface Entry {
  key: string;
  s: Session;
  /** Workspace folder that matched the cwd, for the project label. */
  folder?: string;
  terminalShellPid?: number;
}

/** What the attention context needs to know about a session. */
export interface Place {
  entrypoint?: string;
  terminalShellPid?: number;
}

export interface StoreDeps {
  now(): number;
  level(p: Place): Level;
  /** Carry out an alert. receivedAt is set when the alert was caused directly by a hook event. */
  alert(e: Entry, alert: Alert, receivedAt?: number): void;
  withdraw(e: Entry): void;
  changed(): void;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

export class SessionStore {
  private entries = new Map<string, Entry>();
  private watchTimers = new Map<string, unknown>();
  private ackTimers = new Map<string, unknown>();

  constructor(private readonly deps: StoreDeps) {}

  list(): Entry[] {
    return [...this.entries.values()];
  }

  get(key: string): Entry | undefined {
    return this.entries.get(key);
  }

  onRouted(r: RoutedEvent): void {
    const key = r.event.sessionKey;
    const prev = this.entries.get(key);
    const entry: Entry = prev ?? { key, s: undefined as unknown as Session };
    if (r.folder) entry.folder = r.folder;
    if (r.terminalShellPid) entry.terminalShellPid = r.terminalShellPid;
    this.apply(entry, prev?.s, { type: 'event', event: r.event }, r.event.receivedAt);
  }

  ack(key: string): void {
    const e = this.entries.get(key);
    if (e) this.apply(e, e.s, { type: 'ack' });
  }

  /** Focus, activity, the active terminal or tab changed. */
  contextChanged(): void {
    for (const e of this.entries.values()) {
      const level = this.deps.level(place(e));
      if (level >= 2 && e.s.pending?.deferred && !e.s.pending.fired) this.apply(e, e.s, { type: 'away' });
      this.updateFocusAck(e, level);
    }
  }

  dispose(): void {
    for (const t of [...this.watchTimers.values(), ...this.ackTimers.values()]) this.deps.clearTimer(t);
    this.watchTimers.clear();
    this.ackTimers.clear();
  }

  private apply(e: Entry, prev: Session | undefined, input: Input, receivedAt?: number): void {
    const entrypoint = (input.type === 'event' ? input.event.entrypoint : undefined) ?? prev?.entrypoint;
    const level = this.deps.level({ entrypoint, terminalShellPid: e.terminalShellPid });
    const result = reduce(prev, input, { now: this.deps.now(), level });
    if (result.session) {
      e.s = result.session;
      this.entries.set(e.key, e);
    }
    for (const effect of result.effects) this.run(e, effect, receivedAt);
    if (this.entries.has(e.key)) this.updateFocusAck(e, this.deps.level(place(e)));
    this.deps.changed();
  }

  private run(e: Entry, effect: Effect, receivedAt?: number): void {
    switch (effect.type) {
      case 'alert':
        this.deps.alert(e, effect.alert, receivedAt);
        break;
      case 'withdraw':
        this.deps.withdraw(e);
        break;
      case 'arm-watch':
        this.clear(this.watchTimers, e.key);
        this.watchTimers.set(
          e.key,
          this.deps.setTimer(() => {
            this.watchTimers.delete(e.key);
            const cur = this.entries.get(e.key);
            if (cur) this.apply(cur, cur.s, { type: 'watch-timeout' });
          }, effect.ms),
        );
        break;
      case 'disarm-watch':
        this.clear(this.watchTimers, e.key);
        break;
      case 'remove':
        this.clear(this.watchTimers, e.key);
        this.clear(this.ackTimers, e.key);
        this.entries.delete(e.key);
        break;
    }
  }

  /** Acknowledge an alert once you've watched its session for FOCUS_ACK_MS. */
  private updateFocusAck(e: Entry, level: Level): void {
    const watching = level === 0 && e.s.attention !== undefined;
    if (!watching) return this.clear(this.ackTimers, e.key);
    if (this.ackTimers.has(e.key)) return;
    this.ackTimers.set(
      e.key,
      this.deps.setTimer(() => {
        this.ackTimers.delete(e.key);
        const cur = this.entries.get(e.key);
        if (cur?.s.attention && this.deps.level(place(cur)) === 0) this.apply(cur, cur.s, { type: 'ack' });
      }, FOCUS_ACK_MS),
    );
  }

  private clear(map: Map<string, unknown>, key: string): void {
    const t = map.get(key);
    if (t !== undefined) this.deps.clearTimer(t);
    map.delete(key);
  }
}

function place(e: Entry): Place {
  return { entrypoint: e.s.entrypoint, terminalShellPid: e.terminalShellPid };
}
