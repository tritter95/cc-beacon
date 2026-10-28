import { describe, expect, it } from 'vitest';
import { canonicalJson, normalize } from '../../src/claude/normalize';
import { loadEvents, loadRun, RUNS } from './fixtures';

describe('normalize', () => {
  it.each(RUNS)('handles every record in %s without throwing', (run) => {
    for (const r of loadRun(run)) expect(() => normalize(r.body, r.headers, 0)).not.toThrow();
  });

  it('maps a Bash PermissionRequest to needs-input/permission with its description', () => {
    const ev = loadEvents('command-run').find((e) => e.ev.hook === 'PermissionRequest')!.ev;
    expect(ev).toMatchObject({
      kind: 'needs-input',
      reason: 'permission',
      toolName: 'Bash',
      detail: 'Create empty file probe-file-4.txt',
      windowHint: 'tmux-window-1',
      entrypoint: 'cli',
      claudePid: 46668,
      promptId: '481c3e72-0cb1-417c-8d2d-a139700bf23a',
    });
  });

  it('gives a PermissionRequest and its PostToolUse the same toolKey', () => {
    const evs = loadEvents('command-run').map((e) => e.ev);
    const req = evs.find((e) => e.hook === 'PermissionRequest')!;
    const post = evs.find((e) => e.hook === 'PostToolUse')!;
    expect(req.toolKey).toBeTruthy();
    expect(post.toolKey).toBe(req.toolKey);
    expect(post).toMatchObject({ kind: 'progress', reason: 'resolved' });
  });

  it('maps AskUserQuestion to a question with the question text', () => {
    const ev = loadEvents('panel-run').find((e) => e.ev.hook === 'PermissionRequest')!.ev;
    expect(ev).toMatchObject({ kind: 'needs-input', reason: 'question', detail: 'Red or blue?', entrypoint: 'claude-vscode' });
    expect(ev.windowHint).toBe('probe-testproj3');
  });

  it('counts extra questions', () => {
    const ev = loadEvents('synthetic').find((e) => e.ev.toolName === 'AskUserQuestion')!.ev;
    expect(ev.detail).toBe('Which database? (+1 more)');
  });

  it('uses the file name for file tools without a description', () => {
    const ev = loadEvents('synthetic').find((e) => e.ev.toolName === 'Write')!.ev;
    expect(ev).toMatchObject({ reason: 'permission', detail: 'index.ts' });
  });

  it('maps Notification types', () => {
    const evs = loadEvents('command-run').map((e) => e.ev);
    expect(evs.find((e) => e.notificationType === 'permission_prompt')).toMatchObject({ kind: 'needs-input', reason: 'permission' });
    expect(evs.find((e) => e.notificationType === 'idle_prompt')).toMatchObject({ kind: 'needs-input', reason: 'idle' });
    const syn = loadEvents('synthetic').map((e) => e.ev);
    expect(syn.find((e) => e.notificationType === 'elicitation_dialog')).toMatchObject({ kind: 'needs-input', reason: 'elicitation' });
    expect(syn.find((e) => e.notificationType === 'brand_new_type')).toMatchObject({ kind: 'info', reason: 'other' });
  });

  it('maps Stop with its last message', () => {
    const ev = loadEvents('command-run').find((e) => e.ev.hook === 'Stop')!.ev;
    expect(ev.kind).toBe('completed');
    expect(ev.detail).toMatch(/^I ran `touch probe-file-4.txt`/);
    expect(ev.endsWithQuestion).toBe(false);
    const q = normalize({ session_id: 's', hook_event_name: 'Stop', last_assistant_message: 'Should I continue?  \n' }, {}, 0);
    expect(q?.endsWithQuestion).toBe(true);
  });

  it('maps StopFailure with a nested error message', () => {
    const ev = loadEvents('synthetic').find((e) => e.ev.hook === 'StopFailure')!.ev;
    expect(ev).toMatchObject({ kind: 'failed', reason: 'error', detail: 'Overloaded' });
  });

  it('treats unknown and ignored hooks as info', () => {
    const evs = [...loadEvents('command-run'), ...loadEvents('panel-run'), ...loadEvents('synthetic')].map((e) => e.ev);
    for (const hook of ['SubagentStop', 'SessionStart', 'PreToolUse', 'latency-test', 'BrandNewHook']) {
      const ev = evs.find((e) => e.hook === hook);
      expect(ev, hook).toBeDefined();
      expect(ev!.kind, hook).toBe('info');
    }
  });

  it('treats empty header values as missing', () => {
    const ev = loadEvents('vscode-terminal-run').find((e) => e.ev.hook === 'UserPromptSubmit')!.ev;
    expect(ev.windowHint).toBeUndefined();
    expect(ev.entrypoint).toBe('cli');
  });

  it('rejects payloads it cannot route', () => {
    expect(normalize(null, {}, 0)).toBeNull();
    expect(normalize('text', {}, 0)).toBeNull();
    expect(normalize([1, 2], {}, 0)).toBeNull();
    expect(normalize({ hook_event_name: 'Stop' }, {}, 0)).toBeNull();
  });

  it('ignores malformed pid headers', () => {
    for (const pid of ['abc', '-3', '0', '12x']) {
      expect(normalize({ session_id: 's' }, { 'x-cc-beacon-claude-pid': pid }, 0)?.claudePid).toBeUndefined();
    }
  });

  it('caps long details', () => {
    const ev = normalize({ session_id: 's', hook_event_name: 'Stop', last_assistant_message: 'x'.repeat(10_000) }, {}, 0);
    expect(ev!.detail!.length).toBe(2000);
  });

  it('builds canonical JSON independent of key order', () => {
    expect(canonicalJson({ b: 1, a: [{ d: 2, c: 3 }] })).toBe(canonicalJson({ a: [{ c: 3, d: 2 }], b: 1 }));
  });
});
