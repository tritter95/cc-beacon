import http from 'node:http';
import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { Coordinator, type Role } from '../../src/hub/election';
import { PATHS } from '../../src/hub/protocol';
import type { RoutedEvent, WindowInfo } from '../../src/model';
import { styleFor } from '../../src/routing/pathNormalize';

const TOKEN = 'a'.repeat(48);

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

interface Win {
  id: string;
  coord: Coordinator;
  events: RoutedEvent[];
  roles: Role[];
  info: WindowInfo;
}

const started: Win[] = [];
afterEach(async () => {
  await Promise.all(started.splice(0).map((w) => w.coord.stop()));
});

function makeWindow(port: number, id: string, folders: string[] = [], ancestryDelay = 0): Win {
  const w: Win = {
    id,
    events: [],
    roles: [],
    info: { windowId: id, protocol: 1, name: id, extHostPid: 0, folders, focused: false, active: false, lastFocusedAt: 0, terminals: [] },
  } as unknown as Win;
  w.coord = new Coordinator({
    port,
    token: TOKEN,
    version: 'test',
    windowId: id,
    getInfo: () => w.info,
    routerOptions: {
      style: styleFor('darwin'),
      unmatched: () => 'ignore',
      ancestry: async () => {
        await new Promise((r) => setTimeout(r, ancestryDelay));
        return [];
      },
    },
    onEvent: (r) => w.events.push(r),
    onRole: (role) => w.roles.push(role),
    log: () => {},
    timing: { healthDelayMs: 50, jitterMs: 100, errorRetryMs: 500 },
  });
  started.push(w);
  return w;
}

function post(port: number, body: unknown, headers: Record<string, string> = {}, path: string = PATHS.hook): Promise<number> {
  const data = typeof body === 'string' ? body : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method: 'POST',
        path,
        agent: false,
        headers: { 'Content-Type': 'application/json', 'X-CC-Beacon-Token': TOKEN, Host: `127.0.0.1:${port}`, ...headers },
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      },
    );
    req.on('error', reject);
    req.end(data);
  });
}

const hook = (session: string, window: string, extra: Record<string, unknown> = {}) => ({
  body: { session_id: session, hook_event_name: 'Stop', cwd: '/x', ...extra },
  headers: { 'X-CC-Beacon-Window': window },
});

async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('hub election and routing', () => {
  it('elects exactly one hub among windows starting together, and routes to each window', async () => {
    const port = await freePort();
    const wins = ['w1', 'w2', 'w3'].map((id) => makeWindow(port, id));
    await Promise.all(wins.map((w) => w.coord.start()));
    expect(wins.filter((w) => w.coord.role === 'hub')).toHaveLength(1);
    expect(wins.filter((w) => w.coord.role === 'spoke')).toHaveLength(2);

    for (const w of wins) {
      const h = hook(`s-${w.id}`, w.id);
      expect(await post(port, h.body, h.headers)).toBe(204);
    }
    await until(() => wins.every((w) => w.events.length === 1));
    for (const w of wins) expect(w.events[0].event.sessionKey).toBe(`s-${w.id}`);
  });

  it('fails over to exactly one new hub when the hub window closes', async () => {
    const port = await freePort();
    const wins = ['w1', 'w2', 'w3'].map((id) => makeWindow(port, id));
    await Promise.all(wins.map((w) => w.coord.start()));
    const hub = wins.find((w) => w.coord.role === 'hub')!;
    const rest = wins.filter((w) => w !== hub);

    const t0 = Date.now();
    await hub.coord.stop();
    await until(() => rest.filter((w) => w.coord.role === 'hub').length === 1 && rest.some((w) => w.coord.role === 'spoke'));
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(rest.filter((w) => w.coord.role === 'hub')).toHaveLength(1);

    // Both remaining windows are registered with the new hub.
    for (const w of rest) {
      const h = hook(`after-${w.id}`, w.id);
      await until(() => w.coord.role === 'hub' || w.coord.role === 'spoke');
      await post(port, h.body, h.headers);
    }
    await until(() => rest.every((w) => w.events.some((e) => e.event.sessionKey === `after-${w.id}`)));
  });

  it('routes by cwd after a spoke updates its folders', async () => {
    const port = await freePort();
    const a = makeWindow(port, 'a');
    await a.coord.start();
    const b = makeWindow(port, 'b');
    await b.coord.start();
    expect(b.coord.role).toBe('spoke');
    b.info = { ...b.info, folders: ['/work/b'], lastFocusedAt: 5 };
    b.coord.update();
    const diag = async () => (await a.coord.hubDiagnostics())!.windows.find((w) => w.windowId === 'b')?.folders;
    for (let i = 0; i < 50 && (await diag())?.length !== 1; i++) await new Promise((r) => setTimeout(r, 10));
    expect(await diag()).toEqual(['/work/b']);
    expect((await b.coord.hubDiagnostics())?.role).toBe('hub');
  });

  it('keeps one session\'s events in order even when routing is slow', async () => {
    const port = await freePort();
    const w = makeWindow(port, 'w', [], 30);
    await w.coord.start();
    // First event has a pid, so routing waits on (slow) ancestry; the rest route by header.
    await post(port, { session_id: 's', hook_event_name: 'UserPromptSubmit' }, { 'X-CC-Beacon-Window': 'w', 'X-CC-Beacon-Claude-Pid': '123' });
    await post(port, { session_id: 's', hook_event_name: 'PermissionRequest', tool_name: 'Bash' }, { 'X-CC-Beacon-Window': 'w' });
    await post(port, { session_id: 's', hook_event_name: 'Stop' }, { 'X-CC-Beacon-Window': 'w' });
    await until(() => w.events.length === 3);
    expect(w.events.map((e) => e.event.hook)).toEqual(['UserPromptSubmit', 'PermissionRequest', 'Stop']);
  });

  it('records dropped events in diagnostics', async () => {
    const port = await freePort();
    const w = makeWindow(port, 'w');
    await w.coord.start();
    await post(port, { session_id: 's', hook_event_name: 'Stop' }, { 'X-CC-Beacon-Window': 'nope' });
    await until(() => (w.coord as unknown as { hub: { diagnostics(): { recent: unknown[] } } }).hub.diagnostics().recent.length === 1);
    const d = (await w.coord.hubDiagnostics())!;
    expect(d.recent[0]).toMatchObject({ hook: 'Stop', dropped: 'unmatched' });
    expect(d.received).toBe(1);
  });

  it('reports a foreign program on the port as an error', async () => {
    const port = await freePort();
    const squatter = http.createServer((_q, s) => s.writeHead(200).end('hello'));
    await new Promise<void>((r) => squatter.listen(port, '127.0.0.1', () => r()));
    try {
      const w = makeWindow(port, 'w');
      await w.coord.start();
      expect(w.coord.role).toBe('error');
      expect(w.coord.detail).toMatch(/used by another program/);
    } finally {
      await new Promise((r) => squatter.close(r));
    }
  });
});

describe('hub request security', () => {
  async function hubPort(): Promise<number> {
    const port = await freePort();
    await makeWindow(port, 'w').coord.start();
    return port;
  }
  const body = { session_id: 's', hook_event_name: 'Stop' };

  it('rejects a missing or wrong token', async () => {
    const port = await hubPort();
    expect(await post(port, body, { 'X-CC-Beacon-Token': 'b'.repeat(48) })).toBe(401);
    expect(await post(port, body, { 'X-CC-Beacon-Token': '' })).toBe(401);
  });

  it('rejects browser requests (Origin) and foreign Host headers', async () => {
    const port = await hubPort();
    expect(await post(port, body, { Origin: 'https://evil.example' })).toBe(403);
    expect(await post(port, body, { Host: `evil.example:${port}` })).toBe(403);
    expect(await post(port, body, { Host: `localhost:${port}` })).toBe(204);
  });

  it('rejects non-JSON content types, bad JSON and oversized bodies', async () => {
    const port = await hubPort();
    expect(await post(port, body, { 'Content-Type': 'text/plain' })).toBe(415);
    expect(await post(port, '{not json')).toBe(400);
    expect(await post(port, JSON.stringify({ session_id: 's', pad: 'x'.repeat(1024 * 1024) }))).toBe(413);
  });

  it('answers unknown paths with 404', async () => {
    const port = await hubPort();
    expect(await post(port, body, {}, '/cc-beacon/v1/nope')).toBe(404);
  });
});
