// Maps raw Claude Code hook payloads to BeaconEvents (PLAN §4.1). Must never throw: Claude
// Code's hook surface changes fast, so anything unknown becomes kind 'info'.
import { createHash } from 'node:crypto';
import path from 'node:path';
import type { BeaconEvent, Kind, Reason } from '../model';

export const HEADER = {
  token: 'x-cc-beacon-token',
  window: 'x-cc-beacon-window',
  entrypoint: 'x-cc-beacon-entrypoint',
  claudePid: 'x-cc-beacon-claude-pid',
} as const;

/** Keeps memory bounded; presentation truncates further. */
const DETAIL_CAP = 2000;

type Headers = Record<string, string | string[] | undefined>;
type Obj = Record<string, unknown>;

export function normalize(body: unknown, headers: Headers, receivedAt: number): BeaconEvent | null {
  if (!isObj(body)) return null;
  const sessionKey = str(body.session_id);
  if (!sessionKey) return null;
  const hook = str(body.hook_event_name) ?? 'unknown';

  const ev: BeaconEvent = {
    sessionKey,
    hook,
    kind: 'info',
    reason: 'other',
    cwd: str(body.cwd),
    promptId: str(body.prompt_id),
    windowHint: header(headers, HEADER.window),
    entrypoint: header(headers, HEADER.entrypoint),
    claudePid: pid(header(headers, HEADER.claudePid)),
    receivedAt,
  };
  const set = (kind: Kind, reason: Reason, detail?: string) => {
    ev.kind = kind;
    ev.reason = reason;
    if (detail) ev.detail = cap(detail);
  };

  switch (hook) {
    case 'PermissionRequest': {
      const tool = str(body.tool_name);
      ev.toolName = tool;
      ev.toolKey = toolKey(tool, body.tool_input);
      if (tool === 'AskUserQuestion') set('needs-input', 'question', questionText(body.tool_input));
      else set('needs-input', 'permission', approvalText(body.tool_input));
      break;
    }
    case 'Notification': {
      const type = str(body.notification_type);
      ev.notificationType = type;
      const message = str(body.message);
      switch (type) {
        case 'permission_prompt': set('needs-input', 'permission', message); break;
        case 'elicitation_dialog':
        case 'elicitation_url_dialog': set('needs-input', 'elicitation', message); break;
        case 'idle_prompt': set('needs-input', 'idle', message); break;
        case 'agent_needs_input': set('needs-input', 'other', message); break;
        default: set('info', 'other', message);
      }
      break;
    }
    case 'Stop': {
      const last = str(body.last_assistant_message);
      set('completed', 'turn-complete', last);
      ev.endsWithQuestion = !!last && /\?\s*$/.test(last);
      break;
    }
    case 'StopFailure':
      set('failed', 'error', errorText(body));
      break;
    case 'UserPromptSubmit':
      set('progress', 'turn-started');
      break;
    case 'PostToolUse':
      ev.toolName = str(body.tool_name);
      ev.toolKey = toolKey(ev.toolName, body.tool_input);
      set('progress', 'resolved');
      break;
    case 'SessionEnd':
      set('ended', 'session-end');
      break;
    default:
      break;
  }
  return ev;
}

function questionText(input: unknown): string | undefined {
  if (!isObj(input) || !Array.isArray(input.questions)) return undefined;
  const qs = input.questions.filter(isObj);
  const first = str(qs[0]?.question);
  if (!first) return undefined;
  return qs.length > 1 ? `${first} (+${qs.length - 1} more)` : first;
}

function approvalText(input: unknown): string | undefined {
  if (!isObj(input)) return undefined;
  const filePath = str(input.file_path) ?? str(input.notebook_path);
  return str(input.description) ?? (filePath && path.basename(filePath)) ?? str(input.command) ?? str(input.url);
}

function errorText(body: Obj): string | undefined {
  for (const key of ['error', 'message', 'reason', 'stop_reason']) {
    const v = body[key];
    if (typeof v === 'string' && v.trim()) return v;
    if (isObj(v)) {
      const m = str(v.message) ?? str(v.type);
      if (m) return m;
    }
  }
  return undefined;
}

/** Pairs a PermissionRequest with its PostToolUse (D15). AskUserQuestion's PostToolUse adds the
 *  answers to tool_input, so only its questions count. */
export function toolKey(tool: string | undefined, input: unknown): string | undefined {
  if (!tool) return undefined;
  const asked = tool === 'AskUserQuestion' && isObj(input) ? { questions: input.questions } : input;
  return createHash('sha1').update(`${tool}\0${canonicalJson(asked)}`).digest('hex').slice(0, 16);
}

export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (isObj(v)) {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

function header(headers: Headers, name: string): string | undefined {
  const v = headers[name];
  const s = (Array.isArray(v) ? v[0] : v)?.trim();
  return s ? s : undefined;
}

function pid(s: string | undefined): number | undefined {
  if (!s || !/^\d+$/.test(s)) return undefined;
  const n = Number(s);
  return n > 0 ? n : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() !== '' ? v : undefined;
}

function cap(s: string): string {
  return s.length > DETAIL_CAP ? s.slice(0, DETAIL_CAP) : s;
}

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
