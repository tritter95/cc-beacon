import { describe, expect, it } from 'vitest';
import { LatencyStats, older, renderReport, type ReportInput } from '../../src/diagnostics';

describe('LatencyStats', () => {
  it('reports percentiles', () => {
    const l = new LatencyStats();
    expect(l.summary()).toEqual({ n: 0 });
    for (let i = 1; i <= 100; i++) l.add(i);
    expect(l.summary()).toEqual({ n: 100, p50: 50, p95: 95, max: 100 });
  });
});

describe('older', () => {
  it.each([
    ['2.1.232', '2.1.233', true],
    ['2.1.233', '2.1.233', false],
    ['2.2.0', '2.1.233', false],
    ['1.9.999', '2.1.233', true],
  ])('%s < %s is %s', (a, b, out) => expect(older(a, b)).toBe(out));
});

describe('renderReport', () => {
  const input: ReportInput = {
    generatedAt: new Date('2026-10-27T12:00:00Z'),
    versions: { vscode: '1.139.1', core: '0.1.0', notifier: '0.1.0', claude: '2.1.200' },
    hub: {
      role: 'hub',
      port: 48813,
      windowId: 'abc',
      envWindow: 'abc',
      diagnostics: {
        role: 'hub',
        pid: 1,
        port: 48813,
        version: '0.1.0',
        protocol: 1,
        hubWindowId: 'abc',
        startedAt: 0,
        windows: [{ windowId: 'abc', protocol: 1, name: 'app|x', extHostPid: 1, folders: ['/a'], focused: true, active: true, lastFocusedAt: 0, terminals: [] }],
        bindings: [],
        received: 3,
        rejected: { token: 2 },
        recent: [{ at: 0, hook: 'Notification', type: 'permission_prompt', session: '12345678abcdef', windowId: 'abc', via: 'header' }],
      },
    },
    hooks: { status: 'ok', disableAllHooks: true, missing: [], outdated: [], file: '/h/.claude/settings.json', exists: true },
    notifier: { caps: { protocol: 1, platform: 'darwin', methods: ['helper'], permission: 'granted', alertStyle: 'banner' }, missing: false },
    entries: [],
    latency: { n: 2, p50: 100, p95: 120, max: 120 },
    muted: false,
  };

  it('covers versions, hub, hooks, notifications and recent events', () => {
    const md = renderReport(input);
    expect(md).toContain('Claude Code 2.1.200 ⚠️ older than 2.1.233');
    expect(md).toContain('This window: **hub**');
    expect(md).toContain('Rejected requests: token 2');
    expect(md).toContain('| app\\|x | abc (hub) | 1 | 0 | yes |');
    expect(md).toContain('`disableAllHooks` is on');
    expect(md).toContain('Permission: granted, alert style banner');
    expect(md).toContain('p50 100 ms, p95 120 ms');
    expect(md).toContain('| 00:00:00.000 | Notification (permission_prompt) | 12345678 |');
  });

  it('flags a missing notifier and missing env injection', () => {
    const md = renderReport({ ...input, versions: { ...input.versions, notifier: undefined }, notifier: { missing: true }, hub: { ...input.hub, envWindow: undefined } });
    expect(md).toContain('Notifier **not installed**');
    expect(md).toContain('Notifier unreachable');
    expect(md).toContain('CC_BEACON_WINDOW in this extension host: **missing**');
  });
});
