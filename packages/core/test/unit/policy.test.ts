import { describe, expect, it } from 'vitest';
import { decide, type Decision, type PolicySettings } from '../../src/attention/policy';
import type { Alert, Level } from '../../src/attention/stateMachine';

const base: PolicySettings = {
  osWhen: 'away',
  inWindowToasts: true,
  minTurnSeconds: 20,
  alerts: { needsInput: true, completed: true, failed: true },
  soundEnabled: true,
};
const needs: Alert = { kind: 'needs-input', reason: 'permission' };
const longDone: Alert = { kind: 'completed', reason: 'turn-complete', turnMs: 60_000 };
const quickDone: Alert = { kind: 'completed', reason: 'turn-complete', turnMs: 5_000 };
const failed: Alert = { kind: 'failed', reason: 'error' };
const reminder: Alert = { kind: 'reminder', reason: 'idle' };

const STATUS: Decision = { statusBar: true, toast: false, os: false, sound: null };
const OS: Decision = { statusBar: true, toast: false, os: true, sound: 'full' };
const TOAST: Decision = { statusBar: true, toast: true, os: false, sound: 'full' };
const SOFT: Decision = { statusBar: true, toast: false, os: false, sound: 'soft' };
const LOUD: Decision = { statusBar: true, toast: false, os: false, sound: 'full' };

describe('policy matrix (PLAN §4.4), osNotifications.when = away', () => {
  const rows: [string, Alert, [Decision, Decision, Decision, Decision]][] = [
    ['needs-input', needs, [SOFT, TOAST, OS, OS]],
    ['completed (long turn)', longDone, [SOFT, TOAST, OS, OS]],
    ['completed (quick turn)', quickDone, [STATUS, STATUS, OS, OS]],
    ['failed', failed, [LOUD, TOAST, OS, OS]],
    ['reminder', reminder, [{ ...STATUS, statusBar: false }, { ...TOAST, sound: null }, OS, OS]],
  ];
  for (const [name, alert, perLevel] of rows) {
    it.each([0, 1, 2, 3] as Level[])(`${name} at L%i`, (level) => {
      expect(decide(alert, level, base, false)).toEqual(perLevel[level]);
    });
  }
});

describe('policy settings', () => {
  it('notWatching sends OS notifications from L1', () => {
    const s = { ...base, osWhen: 'notWatching' as const };
    expect(decide(needs, 0, s, false)).toEqual(SOFT);
    expect(decide(needs, 1, s, false)).toEqual(OS);
  });

  it('always sends OS notifications at every level, but quick turns stay quiet in the window', () => {
    const s = { ...base, osWhen: 'always' as const };
    expect(decide(needs, 0, s, false)).toEqual(OS);
    expect(decide(quickDone, 0, s, false)).toEqual(STATUS);
    expect(decide(quickDone, 2, s, false)).toEqual(OS);
  });

  it('completed with an unknown duration is not gated', () => {
    expect(decide({ kind: 'completed', reason: 'turn-complete' }, 1, base, false)).toEqual(TOAST);
  });

  it('mute leaves only the status bar', () => {
    for (const level of [0, 1, 2, 3] as Level[]) expect(decide(needs, level, base, true)).toEqual(STATUS);
  });

  it('per-event switches turn alerts off entirely', () => {
    const off = { ...base, alerts: { needsInput: false, completed: false, failed: false } };
    for (const a of [needs, longDone, failed, reminder]) expect(decide(a, 2, off, false).statusBar).toBe(false);
  });

  it('without in-window toasts, L1 gets the status bar and sound', () => {
    expect(decide(needs, 1, { ...base, inWindowToasts: false }, false)).toEqual(LOUD);
  });

  it('sound can be turned off', () => {
    expect(decide(needs, 2, { ...base, soundEnabled: false }, false)).toEqual({ ...OS, sound: null });
  });
});
