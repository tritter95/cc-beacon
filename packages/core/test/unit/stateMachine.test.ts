import { describe, expect, it } from 'vitest';
import { DEDUPE_MS, reduce, WATCH_MS, type Alert, type Effect, type Input, type Level, type Session } from '../../src/attention/stateMachine';
import { normalize } from '../../src/claude/normalize';
import type { BeaconEvent } from '../../src/model';
import { loadEvents } from './fixtures';

interface Step {
  t: number;
  session: string;
  input: Input;
}
interface Logged {
  t: number;
  session: string;
  effect: Effect;
}

/** Runs inputs in time order, firing watch timers when they come due, like the session store. */
function simulate(steps: Step[], level: (t: number) => Level = () => 2) {
  const sessions = new Map<string, Session>();
  const timers = new Map<string, number>();
  const log: Logged[] = [];
  const apply = (t: number, key: string, input: Input) => {
    const r = reduce(sessions.get(key), input, { now: t, level: level(t) });
    if (r.session) sessions.set(key, r.session);
    for (const effect of r.effects) {
      log.push({ t, session: key, effect });
      if (effect.type === 'arm-watch') timers.set(key, t + effect.ms);
      if (effect.type === 'disarm-watch') timers.delete(key);
      if (effect.type === 'remove') sessions.delete(key);
    }
  };
  const fireTimersUntil = (t: number) => {
    for (const [key, due] of [...timers].sort((a, b) => a[1] - b[1])) {
      if (due > t) continue;
      timers.delete(key);
      apply(due, key, { type: 'watch-timeout' });
    }
  };
  for (const s of [...steps].sort((a, b) => a.t - b.t)) {
    fireTimersUntil(s.t);
    apply(s.t, s.session, s.input);
  }
  fireTimersUntil(Infinity);
  const alerts = log.filter((l) => l.effect.type === 'alert').map((l) => ({ t: l.t, ...(l.effect as { alert: Alert }).alert }));
  return { sessions, log, alerts };
}

const fromRun = (run: string): Step[] =>
  loadEvents(run).map(({ t, ev }) => ({ t, session: ev.sessionKey, input: { type: 'event', event: ev } }));

/** Times (ms from the run's start) of the events matching a hook and optional notification type. */
const timesOf = (run: string, hook: string, type?: string) =>
  loadEvents(run).filter((e) => e.ev.hook === hook && (!type || e.ev.notificationType === type)).map((e) => e.t);

let n = 0;
function ev(hook: string, extra: Record<string, unknown> = {}): Input {
  const e = normalize({ session_id: 's1', prompt_id: 'p1', hook_event_name: hook, ...extra }, {}, n++) as BeaconEvent;
  return { type: 'event', event: e };
}
const bash = (command: string) => ({ tool_name: 'Bash', tool_input: { command, description: `run ${command}` } });
const step = (t: number, input: Input): Step => ({ t, session: 's1', input });

describe('state machine on recorded runs', () => {
  it('away: alerts on PermissionRequest at once, collapses permission_prompt, reminds on idle_prompt', () => {
    const { alerts, log, sessions } = simulate(fromRun('command-run'), () => 2);
    const main = alerts.filter((a) => a.t < 100_000);
    expect(main.map((a) => [a.kind, a.reason])).toEqual([
      ['needs-input', 'permission'],
      ['completed', 'turn-complete'],
      ['reminder', 'idle'],
    ]);
    expect(main[0].t).toBe(timesOf('command-run', 'PermissionRequest')[0]);
    expect(main[1]).toMatchObject({ turnMs: timesOf('command-run', 'Stop')[0] - timesOf('command-run', 'UserPromptSubmit')[0] });
    // PostToolUse cleared the approval alert.
    const postAt = timesOf('command-run', 'PostToolUse')[0];
    expect(log.some((l) => l.t === postAt && l.effect.type === 'withdraw')).toBe(true);
    // Both sessions ended.
    expect(sessions.size).toBe(1); // only the unknown "x" latency-test session remains
  });

  it('watching: defers PermissionRequest until permission_prompt 6 s later', () => {
    const { alerts } = simulate(fromRun('command-run'), () => 0);
    expect(alerts[0]).toMatchObject({ kind: 'needs-input', reason: 'permission', t: timesOf('command-run', 'Notification', 'permission_prompt')[0] });
  });

  it('watching: an answered prompt never alerts, and a denial leaves the session idle', () => {
    const { alerts, log, sessions } = simulate(fromRun('interactive-run'), () => 0);
    const needs = alerts.filter((a) => a.kind === 'needs-input');
    // Turns 2 and 3 were left unanswered for 6 s; turns 4 and 5 were denied within 6 s.
    expect(needs.map((a) => a.t)).toEqual(timesOf('interactive-run', 'Notification', 'permission_prompt'));
    expect(log.filter((l) => l.effect.type === 'arm-watch')).toHaveLength(4);
    const session = [...sessions.values()].find((s) => s.key.startsWith('bd12bab8'));
    expect(session?.state).toBe('idle');
  });

  it('panel run: question alert while away, then completion', () => {
    const { alerts } = simulate(fromRun('panel-run'), () => 2);
    expect(alerts.map((a) => [a.kind, a.reason])).toEqual([
      ['needs-input', 'question'],
      ['completed', 'turn-complete'],
      ['completed', 'turn-complete'],
      ['reminder', 'idle'],
    ]);
  });
});

describe('state machine rules', () => {
  it('fires a deferred alert when the user leaves the window', () => {
    const { alerts } = simulate([step(0, ev('UserPromptSubmit')), step(1000, ev('PermissionRequest', bash('ls'))), step(3000, { type: 'away' })], () => 0);
    expect(alerts).toEqual([expect.objectContaining({ kind: 'needs-input', t: 3000 })]);
  });

  it('a watch timeout moves to idle, and a late matching PostToolUse moves back to working', () => {
    const { sessions } = simulate([step(0, ev('UserPromptSubmit')), step(1000, ev('PermissionRequest', bash('sleep 30')))], () => 0);
    expect(sessions.get('s1')?.state).toBe('idle');
    const r = reduce(sessions.get('s1'), ev('PostToolUse', bash('sleep 30')), { now: 40_000, level: 0 });
    expect(r.session?.state).toBe('working');
  });

  it('ignores a PostToolUse for a different tool call (async reorder, D15)', () => {
    const { sessions, log } = simulate(
      [step(0, ev('UserPromptSubmit')), step(1000, ev('PermissionRequest', bash('rm -rf build'))), step(1050, ev('PostToolUse', bash('ls')))],
      () => 2,
    );
    expect(sessions.get('s1')?.state).toBe('needs-input');
    expect(log.filter((l) => l.effect.type === 'withdraw')).toHaveLength(0);
  });

  it('ignores a PostToolUse from an earlier turn', () => {
    const steps = [
      step(0, ev('UserPromptSubmit', { prompt_id: 'p2' })),
      step(1000, ev('PermissionRequest', { ...bash('ls'), prompt_id: 'p2' })),
      step(1100, ev('PostToolUse', { ...bash('ls'), prompt_id: 'p1' })),
    ];
    expect(simulate(steps, () => 2).sessions.get('s1')?.state).toBe('needs-input');
  });

  it('ignores a PostToolUse that arrives after Stop', () => {
    const steps = [step(0, ev('UserPromptSubmit')), step(500, ev('Stop')), step(600, ev('PostToolUse', bash('ls')))];
    expect(simulate(steps, () => 2).sessions.get('s1')?.state).toBe('done');
  });

  it('a denial while away keeps needs-input until acknowledged or a new prompt', () => {
    const { sessions } = simulate([step(0, ev('UserPromptSubmit')), step(1000, ev('PermissionRequest', bash('ls')))], () => 2);
    const s = sessions.get('s1')!;
    expect(s.state).toBe('needs-input');
    expect(s.attention).toBeDefined();
    const acked = reduce(s, { type: 'ack' }, { now: 5000, level: 0 });
    expect(acked.effects).toEqual([{ type: 'withdraw' }]);
    expect(acked.session?.attention).toBeUndefined();
    expect(reduce(acked.session, ev('UserPromptSubmit'), { now: 6000, level: 0 }).session?.state).toBe('working');
  });

  it('drops a repeat of the same alert within the dedupe window, but not after a new prompt', () => {
    const steps = [
      step(0, ev('PermissionRequest', bash('a'))),
      step(2000, ev('PermissionRequest', bash('b'))),
      step(DEDUPE_MS + 5000, ev('PermissionRequest', bash('c'))),
      step(DEDUPE_MS + 6000, ev('UserPromptSubmit')),
      step(DEDUPE_MS + 7000, ev('PermissionRequest', bash('d'))),
    ];
    expect(simulate(steps, () => 2).alerts.map((a) => a.t)).toEqual([0, DEDUPE_MS + 5000, DEDUPE_MS + 7000]);
  });

  it('alerts on permission_prompt even if the PermissionRequest was missed', () => {
    const { alerts } = simulate([step(0, ev('Notification', { notification_type: 'permission_prompt', message: 'Claude needs your permission' }))], () => 0);
    expect(alerts).toEqual([expect.objectContaining({ kind: 'needs-input', reason: 'permission' })]);
  });

  it('alerts on elicitation immediately, even while watching', () => {
    const { alerts } = simulate([step(0, ev('Notification', { notification_type: 'elicitation_dialog', message: 'Pick one' }))], () => 0);
    expect(alerts).toEqual([expect.objectContaining({ kind: 'needs-input', reason: 'elicitation', detail: 'Pick one', t: 0 })]);
  });

  it('reports failures and question-like completions', () => {
    const steps = [
      step(0, ev('UserPromptSubmit')),
      step(30_000, ev('Stop', { last_assistant_message: 'Want me to push?' })),
      step(40_000, ev('UserPromptSubmit')),
      step(45_000, ev('StopFailure', { error: 'rate limited' })),
    ];
    const { alerts, sessions } = simulate(steps, () => 2);
    expect(alerts).toEqual([
      expect.objectContaining({ kind: 'completed', endsWithQuestion: true, turnMs: 30_000 }),
      expect.objectContaining({ kind: 'failed', detail: 'rate limited' }),
    ]);
    expect(sessions.get('s1')?.state).toBe('failed');
  });

  it('does not remind once the completion was acknowledged', () => {
    const steps = [step(0, ev('UserPromptSubmit')), step(1000, ev('Stop')), step(2000, { type: 'ack' } as Input), step(61_000, ev('Notification', { notification_type: 'idle_prompt' }))];
    expect(simulate(steps, () => 2).alerts.map((a) => a.kind)).toEqual(['completed']);
  });

  it('reminds only once', () => {
    const idle = () => ev('Notification', { notification_type: 'idle_prompt' });
    const steps = [step(0, ev('Stop')), step(60_000, idle()), step(120_000, idle())];
    expect(simulate(steps, () => 2).alerts.map((a) => a.kind)).toEqual(['completed', 'reminder']);
  });

  it('removes the session on SessionEnd and withdraws its notifications', () => {
    const { sessions, log } = simulate([step(0, ev('Stop')), step(1000, ev('SessionEnd', { reason: 'prompt_input_exit' }))], () => 2);
    expect(sessions.has('s1')).toBe(false);
    expect(log.filter((l) => l.t === 1000).map((l) => l.effect.type)).toEqual(['withdraw', 'remove']);
  });

  it('ignores info events', () => {
    const r = reduce(undefined, ev('SubagentStop'), { now: 0, level: 2 });
    expect(r.effects).toEqual([]);
    expect(r.session?.state).toBe('idle');
  });

  it('ignores timer and ack inputs for unknown sessions', () => {
    expect(reduce(undefined, { type: 'watch-timeout' }, { now: 0, level: 0 })).toEqual({ effects: [] });
    expect(reduce(undefined, { type: 'ack' }, { now: 0, level: 0 })).toEqual({ effects: [] });
  });

  it('arms the watch timer for the documented window', () => {
    const r = reduce(undefined, ev('PermissionRequest', bash('ls')), { now: 0, level: 1 });
    expect(r.effects).toEqual([{ type: 'arm-watch', ms: WATCH_MS }]);
  });
});
