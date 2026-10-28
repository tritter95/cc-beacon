import { describe, expect, it } from 'vitest';
import {
  deriveCapabilities,
  helperSound,
  notificationSettingsUrl,
  parseReply,
  postArgs,
  toPermission,
  withdrawArgs,
} from '../../src/helperCli';

const req = { id: 's1:needs-input', threadId: 's1', title: 'Claude needs approval', clickUri: 'vscode://todd.cc-beacon/focus?s=s1', sound: 'Glass' };

describe('postArgs', () => {
  it('passes every field as its own argument', () => {
    expect(postArgs({ ...req, subtitle: 'proj · Bash', body: 'Run tests', replaceThread: true })).toEqual([
      'post', '--id', 's1:needs-input', '--thread', 's1', '--title', 'Claude needs approval',
      '--subtitle', 'proj · Bash', '--body', 'Run tests', '--sound', 'Glass',
      '--open', 'vscode://todd.cc-beacon/focus?s=s1', '--replace-thread',
    ]);
  });

  it('omits empty optional fields', () => {
    expect(postArgs({ ...req, subtitle: '', body: '', sound: null })).toEqual([
      'post', '--id', 's1:needs-input', '--thread', 's1', '--title', 'Claude needs approval',
      '--sound', 'none', '--open', 'vscode://todd.cc-beacon/focus?s=s1',
    ]);
  });

  it('keeps text that looks like a flag as a value', () => {
    const args = postArgs({ ...req, title: '--replace-thread', body: '--id evil' });
    expect(args.slice(5, 7)).toEqual(['--title', '--replace-thread']);
    expect(args.filter((a) => a === '--replace-thread')).toHaveLength(1);
  });
});

describe('helperSound', () => {
  it('maps null and none to silent', () => {
    expect(helperSound(null)).toBe('none');
    expect(helperSound('none')).toBe('none');
  });
  it('keeps plain names and rejects path-like ones', () => {
    expect(helperSound('Glass')).toBe('Glass');
    expect(helperSound('default')).toBe('default');
    expect(helperSound('../../evil')).toBe('default');
    expect(helperSound('a/b')).toBe('default');
  });
});

describe('withdrawArgs', () => {
  it('withdraws by id or by thread', () => {
    expect(withdrawArgs({ id: 'n1' })).toEqual(['withdraw', '--id', 'n1']);
    expect(withdrawArgs({ threadId: 's1' })).toEqual(['withdraw', '--thread', 's1']);
  });
});

describe('parseReply', () => {
  it('reads the last JSON line', () => {
    expect(parseReply('noise\n{"ok":true,"verb":"status","authorization":"authorized"}\n')).toMatchObject({ ok: true, authorization: 'authorized' });
  });
  it('rejects anything else', () => {
    expect(parseReply('')).toBeUndefined();
    expect(parseReply('not json')).toBeUndefined();
    expect(parseReply('{"verb":"post"}')).toBeUndefined();
    expect(parseReply('[1,2]')).toBeUndefined();
  });
});

describe('toPermission', () => {
  it.each([
    ['authorized', 'granted'], ['provisional', 'granted'], ['ephemeral', 'granted'],
    ['denied', 'denied'], ['notDetermined', 'notDetermined'], ['weird', 'unknown'], [undefined, 'unknown'],
  ] as const)('%s → %s', (input, expected) => {
    expect(toPermission(input)).toBe(expected);
  });
});

describe('deriveCapabilities', () => {
  it('uses the helper when authorized', () => {
    const caps = deriveCapabilities({ kind: 'ok', authorization: 'authorized', alertStyle: 'banner', version: '0.1.0' }, true);
    expect(caps).toMatchObject({ platform: 'darwin', methods: ['helper'], permission: 'granted', alertStyle: 'banner', helperVersion: '0.1.0' });
    expect(caps.problems).toBeUndefined();
  });
  it('offers nothing when denied or not yet asked (no osascript detour)', () => {
    expect(deriveCapabilities({ kind: 'ok', authorization: 'denied' }, true)).toMatchObject({ methods: [], permission: 'denied' });
    expect(deriveCapabilities({ kind: 'ok', authorization: 'notDetermined' }, true)).toMatchObject({ methods: [], permission: 'notDetermined' });
  });
  it('falls back to osascript when the helper is broken', () => {
    const caps = deriveCapabilities({ kind: 'broken', error: 'ENOENT' }, true);
    expect(caps).toMatchObject({ methods: ['osascript'], permission: 'unknown' });
    expect(caps.problems?.[0]).toContain('ENOENT');
    expect(deriveCapabilities({ kind: 'broken', error: 'x' }, false).methods).toEqual([]);
  });
});

it('builds the System Settings deep link', () => {
  expect(notificationSettingsUrl('local.ccbeacon.notifier')).toBe(
    'x-apple.systempreferences:com.apple.Notifications-Settings.extension?id=local.ccbeacon.notifier');
});
