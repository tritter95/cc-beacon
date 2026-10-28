// Our entries in ~/.claude/settings.json (PLAN §4.1, phase1-plan §5.3). Edits go through
// jsonc-parser so the rest of the file keeps its formatting; user hooks are never touched.
// Our entries are recognized by the hook URL path in their command.
import { isDeepStrictEqual } from 'node:util';
import { applyEdits, modify, parse, type FormattingOptions, type ParseError } from 'jsonc-parser';

export const HOOK_MARKER = '/cc-beacon/v1/hook';

export const SUBSCRIPTIONS: readonly { event: string; async?: boolean }[] = [
  { event: 'UserPromptSubmit' },
  { event: 'PermissionRequest' },
  { event: 'Notification' },
  { event: 'PostToolUse', async: true }, // only clears state
  { event: 'Stop' },
  { event: 'StopFailure' },
  { event: 'SessionEnd' },
];

export interface CommandHook {
  type: 'command';
  command: string;
  timeout: number;
  async?: boolean;
}

/** curl with `; exit 0` stays silent when VS Code is closed (ADR 0001 §1). The token comes from a 0600 file (D5). */
export function hookCommand(port: number): string {
  return [
    "curl -s -o /dev/null --noproxy '*' --connect-timeout 1 -m 2 -X POST",
    "-H 'Content-Type: application/json'",
    '-H @"$HOME/.cc-beacon/hook-header"',
    '-H "X-CC-Beacon-Window: $CC_BEACON_WINDOW"',
    '-H "X-CC-Beacon-Entrypoint: $CLAUDE_CODE_ENTRYPOINT"',
    '-H "X-CC-Beacon-Claude-Pid: $CLAUDE_PID"',
    `--data-binary @- http://127.0.0.1:${port}${HOOK_MARKER} >/dev/null 2>&1; exit 0`,
  ].join(' ');
}

export function expectedHook(port: number, async = false): CommandHook {
  return { type: 'command', command: hookCommand(port), timeout: 5, ...(async ? { async: true } : {}) };
}

export type HookStatus = 'ok' | 'missing' | 'partial' | 'outdated' | 'invalid';

export interface Inspection {
  status: HookStatus;
  /** Claude Code's master switch is on: no hook runs, ours included. */
  disableAllHooks: boolean;
  missing: string[];
  outdated: string[];
  error?: string;
}

type Obj = Record<string, unknown>;

interface Found {
  event: string;
  group: number;
  index: number;
  hook: Obj;
  groupObj: Obj;
}

export function inspect(text: string, port: number): Inspection {
  const root = parseRoot(text);
  if ('error' in root) return { status: 'invalid', disableAllHooks: false, missing: [], outdated: [], error: root.error };
  const found = findOurs(root.value);
  const missing: string[] = [];
  const outdated: string[] = [];
  for (const sub of SUBSCRIPTIONS) {
    const ours = found.filter((f) => f.event === sub.event);
    if (ours.length === 0) missing.push(sub.event);
    else if (ours.length > 1 || !matches(ours[0], expectedHook(port, sub.async))) outdated.push(sub.event);
  }
  for (const f of found) {
    if (!SUBSCRIPTIONS.some((s) => s.event === f.event) && !outdated.includes(f.event)) outdated.push(f.event);
  }
  const status: HookStatus =
    outdated.length > 0 ? 'outdated' : missing.length === 0 ? 'ok' : missing.length === SUBSCRIPTIONS.length ? 'missing' : 'partial';
  return { status, disableAllHooks: root.value.disableAllHooks === true, missing, outdated };
}

export type EditResult = { text: string; changed: boolean } | { error: string };

/** Adds or repairs our entries. Up-to-date entries are left exactly as they are. */
export function withHooks(text: string, port: number): EditResult {
  const root = parseRoot(text);
  if ('error' in root) return root;
  const state = inspect(text, port);
  const stale = new Set(state.outdated);
  const add = new Set(SUBSCRIPTIONS.filter((s) => stale.has(s.event) || state.missing.includes(s.event)).map((s) => s.event));
  if (stale.size === 0 && add.size === 0) return { text, changed: false };

  const desired = structuredClone(root.value);
  const hooks = (desired.hooks ??= {}) as Obj;
  for (const event of stale) {
    const list = withoutOurs(hooks[event] as unknown[]);
    if (list.length) hooks[event] = list;
    else delete hooks[event];
  }
  for (const sub of SUBSCRIPTIONS) {
    if (add.has(sub.event)) hooks[sub.event] = [...((hooks[sub.event] as unknown[]) ?? []), { hooks: [expectedHook(port, sub.async)] }];
  }

  const fmt = formatting(text);
  let out = text.trim() === '' ? '{}\n' : text;
  const current = () => (parseRoot(out) as { value: Obj }).value.hooks as Obj | undefined;
  for (const event of new Set([...stale, ...add])) {
    const before = current()?.[event] as unknown[] | undefined;
    const after = hooks[event] as unknown[] | undefined;
    if (!after) out = edit(out, ['hooks', event], undefined, fmt);
    else if (before && !stale.has(event)) {
      // Pure append: insert the new group, leaving the user's groups as they are.
      for (const g of after.slice(before.length)) out = edit(out, ['hooks', event, (current()![event] as unknown[]).length], g, fmt, true);
    } else out = edit(out, ['hooks', event], after, fmt);
  }
  return verified(out, desired, text);
}

/** Removes every entry of ours and nothing else. */
export function withoutHooks(text: string): EditResult & { removed?: number } {
  const root = parseRoot(text);
  if ('error' in root) return root;
  const found = findOurs(root.value);
  if (found.length === 0) return { text, changed: false, removed: 0 };

  const desired = structuredClone(root.value);
  const hooks = desired.hooks as Obj;
  const fmt = formatting(text);
  let out = text;
  for (const event of new Set(found.map((f) => f.event))) {
    const list = withoutOurs(hooks[event] as unknown[]);
    if (list.length) hooks[event] = list;
    else delete hooks[event];
    out = edit(out, ['hooks', event], list.length ? list : undefined, fmt);
  }
  if (Object.keys(hooks).length === 0) {
    delete desired.hooks;
    out = edit(out, ['hooks'], undefined, fmt);
  }
  const result = verified(out, desired, text);
  return 'error' in result ? result : { ...result, removed: found.length };
}

/** A matcher group list without our hooks; groups left empty are dropped. */
function withoutOurs(list: unknown[]): unknown[] {
  return list.flatMap((g) => {
    if (!isObj(g) || !Array.isArray(g.hooks) || !g.hooks.some(isOurs)) return [g];
    const rest = g.hooks.filter((h) => !isOurs(h));
    return rest.length ? [{ ...g, hooks: rest }] : [];
  });
}

/**
 * Text edits must produce exactly the intended object; never write anything else. (jsonc-parser
 * 3.3.1 corrupts arrays when removing their last element, so removals replace whole properties.)
 */
function verified(out: string, desired: Obj, original: string): EditResult {
  const parsed = parseRoot(out);
  if ('error' in parsed || !isDeepStrictEqual(parsed.value, desired)) {
    return { error: "couldn't edit settings.json safely; it was left unchanged" };
  }
  return { text: out, changed: out !== original };
}

function findOurs(root: Obj): Found[] {
  const found: Found[] = [];
  if (!isObj(root.hooks)) return found;
  for (const [event, list] of Object.entries(root.hooks)) {
    if (!Array.isArray(list)) continue;
    list.forEach((groupObj, group) => {
      if (!isObj(groupObj) || !Array.isArray(groupObj.hooks)) return;
      groupObj.hooks.forEach((hook, index) => {
        if (isOurs(hook)) found.push({ event, group, index, hook, groupObj });
      });
    });
  }
  return found;
}

function isOurs(h: unknown): h is Obj {
  if (!isObj(h)) return false;
  return (typeof h.command === 'string' && h.command.includes(HOOK_MARKER)) || (typeof h.url === 'string' && h.url.includes(HOOK_MARKER));
}

function matches(f: Found, want: CommandHook): boolean {
  const matcher = f.groupObj.matcher;
  if (matcher !== undefined && matcher !== '' && matcher !== '*') return false;
  const h = f.hook;
  return (
    h.type === want.type &&
    h.command === want.command &&
    h.timeout === want.timeout &&
    (h.async === true) === (want.async === true) &&
    Object.keys(h).every((k) => ['type', 'command', 'timeout', 'async'].includes(k))
  );
}

function parseRoot(text: string): { value: Obj } | { error: string } {
  if (text.trim() === '') return { value: {} };
  const errors: ParseError[] = [];
  const value: unknown = parse(text, errors, { allowTrailingComma: false, disallowComments: false });
  if (errors.length > 0) return { error: `settings.json isn't valid JSON (error at offset ${errors[0].offset})` };
  if (!isObj(value)) return { error: "settings.json doesn't contain a JSON object" };
  if (value.hooks !== undefined && !isObj(value.hooks)) return { error: '"hooks" in settings.json is not an object' };
  for (const [event, list] of Object.entries((value.hooks as Obj | undefined) ?? {})) {
    if (!Array.isArray(list)) return { error: `"hooks.${event}" in settings.json is not an array` };
  }
  return { value };
}

function edit(text: string, path: (string | number)[], value: unknown, fmt: FormattingOptions, isArrayInsertion = false): string {
  return applyEdits(text, modify(text, path, value, { formattingOptions: fmt, isArrayInsertion }));
}

function formatting(text: string): FormattingOptions {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const indent = /^([ \t]+)"/m.exec(text)?.[1];
  if (indent?.startsWith('\t')) return { insertSpaces: false, tabSize: 1, eol };
  return { insertSpaces: true, tabSize: indent ? indent.length : 2, eol };
}

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
