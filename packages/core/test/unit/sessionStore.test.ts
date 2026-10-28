import { describe, expect, it } from 'vitest';
import { FOCUS_ACK_MS, SessionStore, type Place } from '../../src/attention/sessionStore';
import type { Alert, Level } from '../../src/attention/stateMachine';
import { normalize } from '../../src/claude/normalize';
import type { RoutedEvent } from '../../src/model';

/** A SessionStore on a fake clock, with the level under test control. */
function harness(initial: Level) {
  let now = 0;
  let level = initial;
  let timers: { at: number; fn: () => void; id: number }[] = [];
  let nextId = 1;
  const alerts: { alert: Alert; receivedAt?: number; at: number }[] = [];
  const withdrawn: string[] = [];
  const places: Place[] = [];
  const store = new SessionStore({
    now: () => now,
    level: (p) => {
      places.push(p);
      return level;
    },
    alert: (_e, alert, receivedAt) => alerts.push({ alert, receivedAt, at: now }),
    withdraw: (e) => withdrawn.push(e.key),
    changed: () => {},
    setTimer: (fn, ms) => {
      const t = { at: now + ms, fn, id: nextId++ };
      timers.push(t);
      return t.id;
    },
    clearTimer: (id) => {
      timers = timers.filter((t) => t.id !== id);
    },
  });
  const advance = (ms: number) => {
    const end = now + ms;
    for (;;) {
      const due = timers.filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      timers = timers.filter((t) => t !== due);
      now = due.at;
      due.fn();
    }
    now = end;
  };
  const send = (hook: string, extra: Record<string, unknown> = {}, routed: Partial<RoutedEvent> = {}) => {
    const event = normalize({ session_id: 's1', prompt_id: 'p1', hook_event_name: hook, ...extra }, { 'x-cc-beacon-entrypoint': 'cli' }, now)!;
    store.onRouted({ event, via: 'header', ...routed });
  };
  return {
    store,
    alerts,
    withdrawn,
    places,
    send,
    advance,
    setLevel: (l: Level) => {
      level = l;
      store.contextChanged();
    },
  };
}

const bash = { tool_name: 'Bash', tool_input: { command: 'ls', description: 'List files' } };

describe('SessionStore', () => {
  it('fires a deferred approval when the 6 s prompt arrives, then acknowledges it after you watch for 1.5 s', () => {
    const h = harness(0);
    h.send('UserPromptSubmit');
    h.send('PermissionRequest', bash, { terminalShellPid: 800, folder: '/w/app' });
    expect(h.alerts).toHaveLength(0);
    h.advance(6000);
    h.send('Notification', { notification_type: 'permission_prompt' });
    expect(h.alerts.map((a) => a.alert.kind)).toEqual(['needs-input']);
    expect(h.store.get('s1')).toMatchObject({ folder: '/w/app', terminalShellPid: 800 });
    h.advance(FOCUS_ACK_MS - 1);
    expect(h.withdrawn).toEqual([]);
    h.advance(1);
    expect(h.withdrawn).toEqual(['s1']);
    expect(h.store.get('s1')?.s.attention).toBeUndefined();
  });

  it('times out a deferred approval that was answered', () => {
    const h = harness(1);
    h.send('PermissionRequest', bash);
    h.advance(7000);
    expect(h.alerts).toHaveLength(0);
    expect(h.store.get('s1')?.s.state).toBe('idle');
  });

  it('alerts at once when you leave the window while an approval is deferred', () => {
    const h = harness(0);
    h.send('PermissionRequest', bash);
    h.advance(2000);
    h.setLevel(2);
    expect(h.alerts).toEqual([expect.objectContaining({ at: 2000, alert: expect.objectContaining({ kind: 'needs-input' }) })]);
    h.advance(10_000); // the disarmed watch timer must not fire
    expect(h.store.get('s1')?.s.state).toBe('needs-input');
  });

  it('passes the hook receive time for alerts caused directly by an event', () => {
    const h = harness(2);
    h.advance(500);
    h.send('PermissionRequest', bash);
    expect(h.alerts[0].receivedAt).toBe(500);
  });

  it('does not acknowledge while you are away', () => {
    const h = harness(2);
    h.send('Stop');
    h.advance(10_000);
    expect(h.withdrawn).toEqual([]);
    h.setLevel(0);
    h.advance(FOCUS_ACK_MS);
    expect(h.withdrawn).toEqual(['s1']);
  });

  it('cancels the acknowledgment if you look away before 1.5 s', () => {
    const h = harness(0);
    h.send('Stop');
    h.advance(1000);
    h.setLevel(1);
    h.advance(5000);
    expect(h.withdrawn).toEqual([]);
  });

  it('uses the entrypoint of a brand-new session to judge where you are', () => {
    const h = harness(2);
    h.send('Stop');
    expect(h.places[0]).toEqual({ entrypoint: 'cli', terminalShellPid: undefined });
  });

  it('drops the session on SessionEnd and clears its timers', () => {
    const h = harness(0);
    h.send('PermissionRequest', bash);
    h.send('SessionEnd');
    expect(h.store.list()).toEqual([]);
    h.advance(10_000);
    expect(h.alerts).toEqual([]);
  });
});
