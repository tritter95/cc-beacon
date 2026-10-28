import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { expectedHook, hookCommand, inspect, SUBSCRIPTIONS, withHooks, withoutHooks } from '../../src/claude/hookConfig';
import { claudeSettingsPath, readSettings, writeSettings } from '../../src/claude/settingsFile';

const PORT = 48813;

/** A settings file like Todd's, with no hooks. */
const PLAIN = `{
  "enabledPlugins": {
    "code-review@claude-plugins-official": true
  },
  "effortLevel": "xhigh",
  "tui": "fullscreen"
}
`;

const USER_HOOK = { type: 'command', command: 'say done' };
const WITH_USER_HOOKS = JSON.stringify(
  { hooks: { Stop: [{ hooks: [USER_HOOK] }], PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'audit.sh' }] }] }, model: 'opus' },
  null,
  2,
);

function applied(text: string, port = PORT): string {
  const r = withHooks(text, port);
  if ('error' in r) throw new Error(r.error);
  return r.text;
}
const json = (t: string) => JSON.parse(t);

describe('hookCommand', () => {
  it('matches the ADR form, with the token read from the header file', () => {
    const c = hookCommand(PORT);
    expect(c).toContain("--noproxy '*'");
    expect(c).toContain('-H @"$HOME/.cc-beacon/hook-header"');
    expect(c).toContain('X-CC-Beacon-Window: $CC_BEACON_WINDOW');
    expect(c).toContain('X-CC-Beacon-Claude-Pid: $CLAUDE_PID');
    expect(c).toContain(`http://127.0.0.1:${PORT}/cc-beacon/v1/hook`);
    expect(c.endsWith('; exit 0')).toBe(true);
    expect(c).not.toMatch(/[0-9a-f]{32}/); // no secret in settings.json
  });
});

describe('withHooks', () => {
  it.each([
    ['a missing file', ''],
    ['an empty object', '{}\n'],
    ['plain settings', PLAIN],
  ])('installs every subscription into %s', (_name, text) => {
    const out = applied(text);
    expect(inspect(out, PORT).status).toBe('ok');
    const hooks = json(out).hooks;
    expect(Object.keys(hooks)).toEqual(SUBSCRIPTIONS.map((s) => s.event));
    expect(hooks.PostToolUse[0].hooks[0]).toEqual(expectedHook(PORT, true));
    expect(hooks.Stop[0].hooks[0]).toEqual(expectedHook(PORT));
  });

  it('keeps the rest of the file byte for byte', () => {
    const out = applied(PLAIN);
    const withoutOurs = withoutHooks(out);
    if ('error' in withoutOurs) throw new Error(withoutOurs.error);
    expect(withoutOurs.text).toBe(PLAIN);
    expect(out.startsWith('{\n  "enabledPlugins": {\n    "code-review@claude-plugins-official": true\n  },')).toBe(true);
  });

  it('leaves user hooks alone and adds ours as a separate group', () => {
    const out = json(applied(WITH_USER_HOOKS));
    expect(out.hooks.Stop).toEqual([{ hooks: [USER_HOOK] }, { hooks: [expectedHook(PORT)] }]);
    expect(out.hooks.PreToolUse).toEqual([{ matcher: 'Bash', hooks: [{ type: 'command', command: 'audit.sh' }] }]);
    expect(out.model).toBe('opus');
  });

  it('is idempotent', () => {
    const once = applied(PLAIN);
    const twice = withHooks(once, PORT);
    expect(twice).toEqual({ text: once, changed: false });
  });

  it('repairs entries for an old port without touching user hooks', () => {
    const old = applied(WITH_USER_HOOKS, 48899);
    expect(inspect(old, PORT)).toMatchObject({ status: 'outdated' });
    const out = applied(old);
    expect(inspect(out, PORT).status).toBe('ok');
    expect(out).not.toContain('48899');
    expect(json(out).hooks.Stop).toEqual([{ hooks: [USER_HOOK] }, { hooks: [expectedHook(PORT)] }]);
  });

  it('removes our entries from events we no longer subscribe to (Phase 0 leftovers)', () => {
    const phase0 = JSON.stringify({
      hooks: { PreToolUse: [{ hooks: [{ type: 'http', url: 'http://127.0.0.1:48899/cc-beacon/v1/hook' }] }], ...json(applied('')).hooks },
    });
    expect(inspect(phase0, PORT)).toMatchObject({ status: 'outdated', outdated: ['PreToolUse'] });
    const out = json(applied(phase0));
    expect(out.hooks.PreToolUse).toBeUndefined();
    expect(inspect(JSON.stringify(out), PORT).status).toBe('ok');
  });

  it('treats our hook inside a matcher group as outdated', () => {
    const text = JSON.stringify({ hooks: { Notification: [{ matcher: 'idle_prompt', hooks: [expectedHook(PORT)] }] } });
    expect(inspect(text, PORT).outdated).toContain('Notification');
  });

  it('only splits a shared group, never deletes its user hook', () => {
    const text = JSON.stringify({ hooks: { Stop: [{ hooks: [USER_HOOK, expectedHook(48899)] }] } });
    expect(json(applied(text)).hooks.Stop).toEqual([{ hooks: [USER_HOOK] }, { hooks: [expectedHook(PORT)] }]);
  });

  it('reports partial installs', () => {
    const text = JSON.stringify({ hooks: { Stop: [{ hooks: [expectedHook(PORT)] }] } });
    expect(inspect(text, PORT)).toMatchObject({ status: 'partial', missing: expect.arrayContaining(['UserPromptSubmit']) });
  });

  it('keeps tab indentation', () => {
    const out = applied('{\n\t"model": "opus"\n}\n');
    expect(out).toMatch(/\n\t"hooks": \{\n\t\t"UserPromptSubmit"/);
  });

  it.each([
    ['invalid JSON', '{"model": '],
    ['a trailing comma', '{"model": "opus",}'],
    ['a non-object root', '[1, 2]'],
    ['hooks that is not an object', '{"hooks": []}'],
    ['an event that is not an array', '{"hooks": {"Stop": {}}}'],
  ])('refuses %s', (_name, text) => {
    expect(withHooks(text, PORT)).toHaveProperty('error');
    expect(inspect(text, PORT).status).toBe('invalid');
  });

  it('reports disableAllHooks', () => {
    expect(inspect('{"disableAllHooks": true}', PORT).disableAllHooks).toBe(true);
  });
});

describe('withoutHooks', () => {
  it('removes only our entries, and the hooks key when nothing is left', () => {
    const r = withoutHooks(applied(PLAIN));
    expect(r).toMatchObject({ text: PLAIN, changed: true, removed: SUBSCRIPTIONS.length });
  });

  it('keeps user hooks', () => {
    const r = withoutHooks(applied(WITH_USER_HOOKS));
    if ('error' in r) throw new Error(r.error);
    expect(json(r.text)).toEqual(json(WITH_USER_HOOKS));
  });

  it('does nothing when there is nothing of ours', () => {
    expect(withoutHooks(PLAIN)).toEqual({ text: PLAIN, changed: false, removed: 0 });
  });
});

describe('settings file', () => {
  const dirs: string[] = [];
  afterEach(() => dirs.splice(0).forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
  const tmp = () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-settings-'));
    dirs.push(d);
    return d;
  };

  it('honors CLAUDE_CONFIG_DIR', () => {
    expect(claudeSettingsPath({ CLAUDE_CONFIG_DIR: '/x/claude' })).toBe('/x/claude/settings.json');
  });

  it('creates a missing file and its directory', () => {
    const file = path.join(tmp(), '.claude', 'settings.json');
    expect(readSettings(file)).toEqual({ text: '', exists: false });
    expect(writeSettings(file, '{}\n')).toEqual({ backup: undefined });
    expect(fs.readFileSync(file, 'utf8')).toBe('{}\n');
  });

  it('writes through a symlink, keeps the mode and makes a backup', () => {
    const d = tmp();
    const real = path.join(d, 'dotfiles-settings.json');
    fs.writeFileSync(real, PLAIN, { mode: 0o600 });
    const link = path.join(d, 'settings.json');
    fs.symlinkSync(real, link);
    const { backup } = writeSettings(link, '{"x": 1}\n');
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(real, 'utf8')).toBe('{"x": 1}\n');
    expect(fs.statSync(real).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(backup!, 'utf8')).toBe(PLAIN);
  });

  it('keeps the newest five backups', () => {
    const d = tmp();
    const file = path.join(d, 'settings.json');
    fs.writeFileSync(file, '{}');
    for (let i = 0; i < 8; i++) writeSettings(file, `{"i": ${i}}`, new Date(Date.UTC(2026, 9, 27, 0, 0, i)));
    const backups = fs.readdirSync(d).filter((f) => f.endsWith('.bak'));
    expect(backups).toHaveLength(5);
    expect(backups.sort()[0]).toContain('2026-10-27T00-00-03');
  });
});
