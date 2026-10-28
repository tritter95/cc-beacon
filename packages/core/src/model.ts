// Internal event model. Raw Claude Code hook payloads are normalized into BeaconEvents by
// claude/normalize.ts; everything downstream (routing, state machine, UI) only sees these.

export type Kind = 'needs-input' | 'completed' | 'failed' | 'progress' | 'ended' | 'info';

export type Reason =
  | 'permission'
  | 'question'
  | 'elicitation'
  | 'idle'
  | 'turn-complete'
  | 'error'
  | 'turn-started'
  | 'resolved'
  | 'session-end'
  | 'other';

export interface BeaconEvent {
  /** Claude's session_id. */
  sessionKey: string;
  /** Raw hook_event_name, e.g. "PermissionRequest". */
  hook: string;
  /** Raw notification_type for Notification events. */
  notificationType?: string;
  kind: Kind;
  reason: Reason;
  cwd?: string;
  /** Claude's prompt_id: identifies the turn. */
  promptId?: string;
  toolName?: string;
  /** Hash of tool_name + canonical tool_input. Matches a PostToolUse to its PermissionRequest. */
  toolKey?: string;
  /** Message text worth showing (question, approval description, last assistant message). */
  detail?: string;
  /** Stop: the last assistant message ends with a question mark. */
  endsWithQuestion?: boolean;
  /** X-CC-Beacon-Window header (CC_BEACON_WINDOW). */
  windowHint?: string;
  /** X-CC-Beacon-Entrypoint header (CLAUDE_CODE_ENTRYPOINT): cli, claude-vscode, sdk-cli, ... */
  entrypoint?: string;
  /** X-CC-Beacon-Claude-Pid header (CLAUDE_PID). */
  claudePid?: number;
  /** Hub clock, ms since epoch. */
  receivedAt: number;
}

/** Window state a spoke reports to the hub. */
export interface WindowInfo {
  windowId: string;
  protocol: number;
  name: string;
  extHostPid: number;
  /** Workspace folder paths, already realpath'd. */
  folders: string[];
  focused: boolean;
  active: boolean;
  lastFocusedAt: number;
  terminals: { shellPid: number; name: string }[];
}

export type RouteVia = 'header' | 'sticky' | 'ancestry' | 'cwd' | 'lastFocused';

/** What the hub delivers to the window that owns a session. */
export interface RoutedEvent {
  event: BeaconEvent;
  via: RouteVia;
  /** Shell PID of the terminal running this Claude session, when ancestry found it. */
  terminalShellPid?: number;
  /** Workspace folder that matched the session's cwd, if any. */
  folder?: string;
}
