// Per-session attention state machine (PLAN §4.3, phase1-plan §5.2). A pure reducer: timers are
// returned as effects and run by the session store, so tests drive it with a fake clock.
import type { BeaconEvent, Reason } from '../model';

/** 0 watching, 1 elsewhere in VS Code, 2 away from the window, 3 idle (PLAN §4.4). */
export type Level = 0 | 1 | 2 | 3;

export type SessionState = 'working' | 'needs-input' | 'done' | 'failed' | 'idle';
export type AlertKind = 'needs-input' | 'completed' | 'failed' | 'reminder';

export interface Alert {
  kind: AlertKind;
  reason: Reason;
  detail?: string;
  toolName?: string;
  endsWithQuestion?: boolean;
  /** Turn duration for completed alerts. */
  turnMs?: number;
}

/** The request we're waiting on: a PermissionRequest or an elicitation. */
export interface Pending {
  /** Undefined for elicitations: any PostToolUse in the same turn resolves them. */
  toolKey?: string;
  promptId?: string;
  alert: Alert;
  /** Watching when it arrived: wait for permission_prompt (or the user leaving) before alerting. */
  deferred: boolean;
  fired: boolean;
}

export interface Session {
  key: string;
  state: SessionState;
  /** Why it needs input, or the last alert's reason. */
  reason?: Reason;
  detail?: string;
  toolName?: string;
  cwd?: string;
  entrypoint?: string;
  claudePid?: number;
  promptId?: string;
  turnStartedAt?: number;
  lastTurnMs?: number;
  pending?: Pending;
  /** An alert fired and hasn't been acknowledged. */
  attention?: { kind: AlertKind; reason: Reason; at: number; reminded: boolean };
  lastAlert?: { key: string; at: number };
  createdAt: number;
  updatedAt: number;
}

export type Input =
  | { type: 'event'; event: BeaconEvent }
  /** The watch timer armed by a deferred PermissionRequest ran out without a permission_prompt. */
  | { type: 'watch-timeout' }
  /** The session's level changed to away (2) or idle (3). */
  | { type: 'away' }
  | { type: 'ack' };

export type Effect =
  | { type: 'alert'; alert: Alert }
  | { type: 'withdraw' }
  | { type: 'arm-watch'; ms: number }
  | { type: 'disarm-watch' }
  | { type: 'remove' };

export interface Ctx {
  now: number;
  level: Level;
}

/** permission_prompt follows PermissionRequest after 6.0 s if the prompt is still unanswered. */
export const WATCH_MS = 6500;
export const DEDUPE_MS = 10_000;

export interface Result {
  session?: Session;
  effects: Effect[];
}

export function reduce(prev: Session | undefined, input: Input, ctx: Ctx): Result {
  if (!prev && input.type !== 'event') return { effects: [] };
  const s: Session = prev ? { ...prev } : newSession(input.type === 'event' ? input.event : undefined, ctx.now);
  const effects: Effect[] = [];

  const fire = (alert: Alert) => {
    const key = `${alert.kind}:${alert.reason}`;
    if (s.lastAlert && s.lastAlert.key === key && ctx.now - s.lastAlert.at < DEDUPE_MS) return;
    s.lastAlert = { key, at: ctx.now };
    s.attention = { kind: alert.kind, reason: alert.reason, at: ctx.now, reminded: false };
    effects.push({ type: 'alert', alert });
  };
  const firePending = () => {
    if (!s.pending || s.pending.fired) return;
    s.pending = { ...s.pending, fired: true, deferred: false };
    fire(s.pending.alert);
  };
  const clearAttention = () => {
    if (!s.attention) return;
    s.attention = undefined;
    effects.push({ type: 'withdraw' });
  };
  const dropPending = () => {
    if (s.pending?.deferred) effects.push({ type: 'disarm-watch' });
    s.pending = undefined;
  };

  switch (input.type) {
    case 'watch-timeout':
      // No permission_prompt: the prompt was answered (approved and still running, or denied).
      // Keep pending so a late PostToolUse still moves the session back to working.
      if (s.pending?.deferred && !s.pending.fired) {
        s.pending = { ...s.pending, deferred: false };
        if (s.state === 'needs-input') s.state = 'idle';
      }
      break;

    case 'away':
      if (s.pending?.deferred && !s.pending.fired) {
        effects.push({ type: 'disarm-watch' });
        firePending();
      }
      break;

    case 'ack':
      clearAttention();
      break;

    case 'event': {
      const ev = input.event;
      s.updatedAt = ctx.now;
      if (ev.cwd) s.cwd = ev.cwd;
      if (ev.entrypoint) s.entrypoint = ev.entrypoint;
      if (ev.claudePid) s.claudePid = ev.claudePid;
      const watching = ctx.level <= 1;

      switch (ev.hook) {
        case 'UserPromptSubmit':
          dropPending();
          s.state = 'working';
          s.reason = undefined;
          s.promptId = ev.promptId;
          s.turnStartedAt = ctx.now;
          s.lastAlert = undefined;
          clearAttention();
          break;

        case 'PermissionRequest': {
          dropPending();
          const alert: Alert = { kind: 'needs-input', reason: ev.reason, detail: ev.detail, toolName: ev.toolName };
          setNeedsInput(s, alert);
          s.pending = { toolKey: ev.toolKey, promptId: ev.promptId ?? s.promptId, alert, deferred: watching, fired: false };
          if (watching) effects.push({ type: 'arm-watch', ms: WATCH_MS });
          else firePending();
          break;
        }

        case 'PostToolUse':
          if (s.pending && pendingMatches(s.pending, ev)) {
            dropPending();
            if (s.state === 'needs-input' || s.state === 'idle') s.state = 'working';
            if (s.attention?.kind === 'needs-input') clearAttention();
          }
          break;

        case 'Stop': {
          dropPending();
          const turnMs = s.turnStartedAt !== undefined ? ctx.now - s.turnStartedAt : undefined;
          s.state = 'done';
          s.reason = 'turn-complete';
          s.detail = ev.detail;
          s.lastTurnMs = turnMs;
          s.turnStartedAt = undefined;
          fire({ kind: 'completed', reason: 'turn-complete', detail: ev.detail, endsWithQuestion: ev.endsWithQuestion, turnMs });
          break;
        }

        case 'StopFailure':
          dropPending();
          s.state = 'failed';
          s.reason = 'error';
          s.detail = ev.detail;
          s.turnStartedAt = undefined;
          fire({ kind: 'failed', reason: 'error', detail: ev.detail });
          break;

        case 'SessionEnd':
          if (s.pending?.deferred) effects.push({ type: 'disarm-watch' });
          effects.push({ type: 'withdraw' }, { type: 'remove' });
          return { effects };

        case 'Notification':
          onNotification(s, ev, effects, firePending);
          break;

        default:
          break;
      }
      break;
    }
  }
  return { session: s, effects };
}

function onNotification(
  s: Session,
  ev: BeaconEvent,
  effects: Effect[],
  firePending: () => void,
): void {
  switch (ev.reason) {
    case 'permission':
      // permission_prompt: the request is still unanswered 6 s after PermissionRequest.
      if (s.pending) {
        if (!s.pending.fired) {
          if (s.pending.deferred) effects.push({ type: 'disarm-watch' });
          s.state = 'needs-input';
          firePending();
        }
        // Already alerted for this request: collapse.
      } else {
        // We missed the PermissionRequest (e.g. hooks were installed mid-prompt).
        const alert: Alert = { kind: 'needs-input', reason: 'permission', detail: ev.detail };
        setNeedsInput(s, alert);
        s.pending = { promptId: ev.promptId ?? s.promptId, alert, deferred: false, fired: false };
        firePending();
      }
      break;

    case 'elicitation':
    case 'other': {
      if (ev.kind !== 'needs-input') break;
      // No 6 s follow-up exists for these, so alert at every level right away.
      const alert: Alert = { kind: 'needs-input', reason: ev.reason, detail: ev.detail };
      setNeedsInput(s, alert);
      s.pending = { promptId: ev.promptId ?? s.promptId, alert, deferred: false, fired: false };
      firePending();
      break;
    }

    case 'idle':
      // idle_prompt: a one-shot reminder for an unacknowledged completion.
      if (s.state === 'done' && s.attention?.kind === 'completed' && !s.attention.reminded) {
        const attention = { ...s.attention, reminded: true };
        effects.push({ type: 'alert', alert: { kind: 'reminder', reason: 'idle', detail: s.detail } });
        s.attention = attention;
      }
      break;

    default:
      break;
  }
}

function setNeedsInput(s: Session, alert: Alert): void {
  s.state = 'needs-input';
  s.reason = alert.reason;
  s.detail = alert.detail;
  s.toolName = alert.toolName;
}

function pendingMatches(p: Pending, ev: BeaconEvent): boolean {
  if (p.toolKey !== undefined && p.toolKey !== ev.toolKey) return false;
  if (p.promptId && ev.promptId && p.promptId !== ev.promptId) return false;
  return true;
}

function newSession(ev: BeaconEvent | undefined, now: number): Session {
  return {
    key: ev?.sessionKey ?? '',
    state: 'idle',
    cwd: ev?.cwd,
    entrypoint: ev?.entrypoint,
    claudePid: ev?.claudePid,
    promptId: ev?.promptId,
    createdAt: now,
    updatedAt: now,
  };
}
