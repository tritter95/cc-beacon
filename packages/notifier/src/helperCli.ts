// Talking to CCBeaconNotifier.app's command line: arguments, replies and what they mean.
// No vscode imports, so unit tests cover it directly.
import {
  NOTIFIER_PROTOCOL,
  type Capabilities,
  type NotifyRequest,
  type Permission,
  type WithdrawRequest,
} from '../../shared/src/notifierApi';

/** Never change it: macOS keys the notification permission to the bundle ID. */
export const HELPER_BUNDLE_ID = 'local.ccbeacon.notifier';
/** The bundle's location inside the Notifier extension. */
export const HELPER_APP_RELATIVE = 'native/darwin/build/CCBeaconNotifier.app';
export const HELPER_EXECUTABLE_RELATIVE = 'Contents/MacOS/ccbeacon-notifier';

/** The helper's exit code when notifications aren't allowed (`post` never prompts). */
export const EXIT_NOT_AUTHORIZED = 3;

const SOUND_NAME = /^[A-Za-z0-9 _.-]+$/;

export interface HelperReply {
  ok: boolean;
  verb?: string;
  error?: string;
  authorization?: string;
  alertStyle?: string;
  bundleId?: string;
  version?: string;
  removed?: number;
  remaining?: number;
}

export type HelperProbe =
  | { kind: 'ok'; authorization: string; alertStyle?: string; bundleId?: string; version?: string }
  | { kind: 'broken'; error: string };

export function postArgs(req: NotifyRequest): string[] {
  const args = ['post', '--id', req.id, '--thread', req.threadId, '--title', req.title];
  if (req.subtitle) args.push('--subtitle', req.subtitle);
  if (req.body) args.push('--body', req.body);
  args.push('--sound', helperSound(req.sound));
  if (req.clickUri) args.push('--open', req.clickUri);
  if (req.replaceThread) args.push('--replace-thread');
  return args;
}

/** null → silent. Names that could be paths fall back to the default sound. */
export function helperSound(sound: string | null): string {
  if (sound === null || sound === 'none') return 'none';
  return SOUND_NAME.test(sound) ? sound : 'default';
}

export function withdrawArgs(req: WithdrawRequest): string[] {
  const r = req as { id?: string; threadId?: string };
  return r.id ? ['withdraw', '--id', r.id] : ['withdraw', '--thread', r.threadId ?? ''];
}

/** The helper prints one JSON line; anything else means it didn't run properly. */
export function parseReply(stdout: string): HelperReply | undefined {
  const line = stdout.trim().split('\n').pop();
  if (!line) return undefined;
  try {
    const v: unknown = JSON.parse(line);
    if (v && typeof v === 'object' && typeof (v as HelperReply).ok === 'boolean') return v as HelperReply;
  } catch {
    // fall through
  }
  return undefined;
}

export function toPermission(authorization: string | undefined): Permission {
  switch (authorization) {
    case 'authorized':
    case 'provisional':
    case 'ephemeral':
      return 'granted';
    case 'denied':
      return 'denied';
    case 'notDetermined':
      return 'notDetermined';
    default:
      return 'unknown';
  }
}

export function deriveCapabilities(probe: HelperProbe, osascriptAvailable: boolean): Capabilities {
  if (probe.kind === 'broken') {
    return {
      protocol: NOTIFIER_PROTOCOL,
      platform: 'darwin',
      methods: osascriptAvailable ? ['osascript'] : [],
      permission: 'unknown',
      problems: [`The notification helper can't run (${probe.error}). Using osascript, which can't bring VS Code forward on click.`],
    };
  }
  const permission = toPermission(probe.authorization);
  const caps: Capabilities = {
    protocol: NOTIFIER_PROTOCOL,
    platform: 'darwin',
    methods: permission === 'granted' ? ['helper'] : [],
    permission,
    alertStyle: probe.alertStyle,
    helperVersion: probe.version,
  };
  if (permission === 'denied') {
    caps.problems = ['Notifications for CC Beacon are turned off in System Settings › Notifications.'];
  } else if (permission === 'notDetermined') {
    caps.problems = ["macOS hasn't been asked yet whether CC Beacon may show notifications."];
  }
  return caps;
}

export function notificationSettingsUrl(bundleId: string): string {
  return `x-apple.systempreferences:com.apple.Notifications-Settings.extension?id=${bundleId}`;
}
