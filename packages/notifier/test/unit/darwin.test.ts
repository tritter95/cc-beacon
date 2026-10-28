// DarwinNotifier against fake helper scripts: no real notifications are posted.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { NotifyRequest } from '../../../shared/src/notifierApi';
import { DarwinNotifier } from '../../src/darwin';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-notifier-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const req: NotifyRequest = { id: 's1:needs-input', threadId: 's1', title: 'T', clickUri: 'vscode://x', sound: 'Glass', replaceThread: true };

/** Writes a fake CCBeaconNotifier.app whose helper runs `body` (sh) with the verb in $1. */
function fakeApp(name: string, body: string, mode = 0o755): string {
  const app = path.join(tmp, name, 'CCBeaconNotifier.app');
  const bin = path.join(app, 'Contents', 'MacOS');
  fs.mkdirSync(bin, { recursive: true });
  const script = `#!/bin/sh\necho "$@" >> "${path.join(tmp, name)}/calls.txt"\n${body}\n`;
  fs.writeFileSync(path.join(bin, 'ccbeacon-notifier'), script, { mode });
  return app;
}

const calls = (name: string) => {
  try {
    return fs.readFileSync(path.join(tmp, name, 'calls.txt'), 'utf8').trim().split('\n');
  } catch {
    return [];
  }
};

function notifier(appPath: string, extra: Partial<ConstructorParameters<typeof DarwinNotifier>[0]> = {}) {
  const osascript = vi.fn(async () => ({ ok: true }));
  const log = vi.fn();
  const n = new DarwinNotifier({ appPath, log, osascript, openUrl: async () => ({ ok: true }), ...extra });
  return { n, osascript, log };
}

const AUTHORIZED = `case "$1" in
  status) echo '{"ok":true,"verb":"status","authorization":"authorized","alertStyle":"banner","bundleId":"local.ccbeacon.notifier","version":"9.9.9"}' ;;
  post) echo '{"ok":true,"verb":"post","id":"x","ms":5}' ;;
  withdraw) echo '{"ok":true,"verb":"withdraw","removed":2,"remaining":0}' ;;
  request-permission) echo '{"ok":true,"verb":"request-permission","granted":true,"authorization":"authorized"}' ;;
esac`;

describe.skipIf(process.platform === 'win32')('DarwinNotifier', () => {
  it('posts through the helper with the request as arguments', async () => {
    const { n, osascript } = notifier(fakeApp('authorized', AUTHORIZED));
    const r = await n.notify(req);
    expect(r).toMatchObject({ delivered: true, method: 'helper' });
    expect(r.ms).toBeGreaterThanOrEqual(0);
    expect(osascript).not.toHaveBeenCalled();
    expect(calls('authorized')).toContain('post --id s1:needs-input --thread s1 --title T --sound Glass --open vscode://x --replace-thread');
  });

  it('reports capabilities and caches the status until refreshed', async () => {
    const { n } = notifier(fakeApp('caps', AUTHORIZED));
    expect(await n.capabilities()).toMatchObject({ methods: ['helper'], permission: 'granted', helperVersion: '9.9.9' });
    await n.capabilities();
    expect(calls('caps').filter((c) => c === 'status')).toHaveLength(1);
    n.refresh();
    await n.capabilities();
    expect(calls('caps').filter((c) => c === 'status')).toHaveLength(2);
  });

  it('withdraws and requests permission', async () => {
    const { n } = notifier(fakeApp('withdraw', AUTHORIZED));
    expect(await n.withdraw({ threadId: 's1' })).toEqual({ ok: true });
    expect(await n.requestPermission()).toEqual({ permission: 'granted' });
    expect(calls('withdraw')).toEqual(['withdraw --thread s1', 'request-permission']);
  });

  it('respects a denial: no osascript detour', async () => {
    const { n, osascript } = notifier(fakeApp('denied', `case "$1" in
  status) echo '{"ok":true,"verb":"status","authorization":"denied","alertStyle":"none","bundleId":"local.ccbeacon.notifier","version":"1"}' ;;
  post) echo '{"ok":false,"verb":"post","error":"denied"}'; exit 3 ;;
esac`));
    expect(await n.notify(req)).toMatchObject({ delivered: false, error: 'denied' });
    expect(osascript).not.toHaveBeenCalled();
    expect(await n.capabilities()).toMatchObject({ methods: [], permission: 'denied' });
  });

  it('falls back to osascript when the helper is missing', async () => {
    const { n, osascript } = notifier(path.join(tmp, 'nowhere', 'CCBeaconNotifier.app'));
    expect(await n.notify(req)).toMatchObject({ delivered: true, method: 'osascript' });
    expect(osascript).toHaveBeenCalledOnce();
    const caps = await n.capabilities();
    expect(caps).toMatchObject({ methods: ['osascript'], permission: 'unknown' });
    expect(caps.problems?.[0]).toContain('ENOENT');
  });

  it('falls back to osascript when the helper crashes or fails to add', async () => {
    const crash = notifier(fakeApp('crash', 'kill -KILL $$'));
    expect(await crash.n.notify(req)).toMatchObject({ delivered: true, method: 'osascript' });
    const addError = notifier(fakeApp('adderror', `echo '{"ok":false,"verb":"post","error":"boom"}'; exit 4`));
    expect(await addError.n.notify(req)).toMatchObject({ delivered: true, method: 'osascript' });
    expect(addError.log.mock.calls.flat().join('\n')).toContain('boom');
  });

  it('reports both failures when osascript fails too', async () => {
    const { n } = notifier(fakeApp('bothfail', 'exit 9'), { osascript: async () => ({ ok: false, error: 'nope' }) });
    const r = await n.notify(req);
    expect(r).toMatchObject({ delivered: false, method: 'osascript' });
    expect(r.error).toContain('exit 9');
    expect(r.error).toContain('nope');
  });

  it("doesn't fall back after a timeout, which could show the alert twice", async () => {
    const { n, osascript } = notifier(fakeApp('slow', 'sleep 2'), { timeoutMs: 200 });
    expect(await n.notify(req)).toMatchObject({ delivered: false, error: 'helper timed out' });
    expect(osascript).not.toHaveBeenCalled();
  });

  it('opens System Settings for the bundle the helper reports', async () => {
    const openUrl = vi.fn(async () => ({ ok: true }));
    const { n } = notifier(fakeApp('settings', AUTHORIZED), { openUrl });
    await n.openSettings();
    expect(openUrl).toHaveBeenCalledWith('x-apple.systempreferences:com.apple.Notifications-Settings.extension?id=local.ccbeacon.notifier');
  });

  it('prepare restores the exec bit', async () => {
    const app = fakeApp('noexec', AUTHORIZED, 0o644);
    const { n, log } = notifier(app);
    await n.prepare();
    expect(fs.statSync(n.helperPath).mode & 0o777).toBe(0o755);
    expect(log.mock.calls.flat().join('\n')).toContain('executable');
  });

  it.skipIf(process.platform !== 'darwin')('prepare clears a quarantine flag', async () => {
    const app = fakeApp('quarantined', AUTHORIZED);
    const { n, log } = notifier(app);
    execFileSync('/usr/bin/xattr', ['-w', 'com.apple.quarantine', '0081;00000000;Safari;', n.helperPath]);
    await n.prepare();
    const left = execFileSync('/usr/bin/find', [app, '-xattrname', 'com.apple.quarantine'], { encoding: 'utf8' });
    expect(left.trim()).toBe('');
    expect(log.mock.calls.flat().join('\n')).toContain('quarantine');
  });
});
