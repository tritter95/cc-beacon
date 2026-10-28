// Contract between CC Beacon Core (workspace side) and CC Beacon Notifier (UI side).
// Core calls these commands with vscode.commands.executeCommand. In a remote window the call
// crosses extension hosts, so every argument and result must be plain JSON.

export const NOTIFIER_PROTOCOL = 1;

export const NotifierCommand = {
  capabilities: 'ccBeacon.notifier.capabilities',
  notify: 'ccBeacon.notifier.notify',
  withdraw: 'ccBeacon.notifier.withdraw',
  playSound: 'ccBeacon.notifier.playSound',
  requestPermission: 'ccBeacon.notifier.requestPermission',
  openSettings: 'ccBeacon.notifier.openSettings',
} as const;

export type NotifyMethod = 'helper' | 'osascript';
export type Permission = 'granted' | 'denied' | 'notDetermined' | 'unknown';

export interface Capabilities {
  protocol: number;
  platform: NodeJS.Platform;
  /** Delivery methods that can post right now, best first. Empty means in-window alerts only. */
  methods: NotifyMethod[];
  permission: Permission;
  /** macOS: 'banner' | 'alert' | 'none' as reported by the helper. */
  alertStyle?: string;
  helperVersion?: string;
  /** Why a method is unavailable, for Diagnose. */
  problems?: string[];
}

export interface NotifyRequest {
  /** Notification id. Posting the same id again replaces the earlier notification. */
  id: string;
  /** Groups notifications per session. withdraw({ threadId }) removes the whole group. */
  threadId: string;
  title: string;
  subtitle?: string;
  body?: string;
  /** A sound name ('Glass', 'default', ...) or null for silent. */
  sound: string | null;
  /** Opened when the notification is clicked (a vscode:// URI from env.asExternalUri). */
  clickUri: string;
  /** Remove this thread's other delivered notifications first, so a session shows one at a time. */
  replaceThread?: boolean;
}

export interface NotifyResult {
  delivered: boolean;
  method?: NotifyMethod;
  /** Time the notifier spent delivering, in milliseconds. */
  ms: number;
  error?: string;
}

export type WithdrawRequest = { id: string } | { threadId: string };

export interface PlaySoundRequest {
  name: string;
  /** 0..1 */
  volume: number;
}

export interface OkResult {
  ok: boolean;
  error?: string;
}

export interface PermissionResult {
  permission: Permission;
}
