// The attention ladder (PLAN §4.4): how loud an alert is, given where you are.
import type { Alert, Level } from './stateMachine';

export type OsWhen = 'away' | 'notWatching' | 'always';

export interface PolicySettings {
  osWhen: OsWhen;
  inWindowToasts: boolean;
  minTurnSeconds: number;
  alerts: { needsInput: boolean; completed: boolean; failed: boolean };
  soundEnabled: boolean;
}

export interface Decision {
  /** Status bar reflects the alert (it always reflects state; this marks it as attention). */
  statusBar: boolean;
  toast: boolean;
  os: boolean;
  /** 'full' with toasts and OS notifications, 'soft' (quieter) while watching. */
  sound: 'full' | 'soft' | null;
}

const NONE: Decision = { statusBar: false, toast: false, os: false, sound: null };

export function decide(alert: Alert, level: Level, settings: PolicySettings, muted: boolean): Decision {
  if (!enabledFor(alert, settings)) return NONE;
  if (muted) return { ...NONE, statusBar: true };

  // Quick turns don't deserve an alert while you're in the window.
  if (alert.kind === 'completed' && level <= 1 && (alert.turnMs ?? Infinity) < settings.minTurnSeconds * 1000) {
    return { ...NONE, statusBar: true };
  }

  const osFrom = settings.osWhen === 'always' ? 0 : settings.osWhen === 'notWatching' ? 1 : 2;

  if (alert.kind === 'reminder') {
    if (level >= osFrom) return { statusBar: true, toast: false, os: true, sound: sound(settings, 'full') };
    if (level === 1 && settings.inWindowToasts) return { statusBar: true, toast: true, os: false, sound: null };
    return { ...NONE, statusBar: level !== 0 };
  }

  if (level >= osFrom) return { statusBar: true, toast: false, os: true, sound: sound(settings, 'full') };
  if (level === 1) {
    return { statusBar: true, toast: settings.inWindowToasts, os: false, sound: sound(settings, 'full') };
  }
  // L0: you're looking at it.
  return { statusBar: true, toast: false, os: false, sound: sound(settings, alert.kind === 'failed' ? 'full' : 'soft') };
}

function enabledFor(alert: Alert, s: PolicySettings): boolean {
  switch (alert.kind) {
    case 'needs-input': return s.alerts.needsInput;
    case 'completed': return s.alerts.completed;
    case 'failed': return s.alerts.failed;
    case 'reminder': return s.alerts.needsInput || s.alerts.completed;
  }
}

function sound(s: PolicySettings, v: 'full' | 'soft'): 'full' | 'soft' | null {
  return s.soundEnabled ? v : null;
}
