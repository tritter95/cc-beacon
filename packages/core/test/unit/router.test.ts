import { describe, expect, it } from 'vitest';
import { normalize } from '../../src/claude/normalize';
import type { BeaconEvent, WindowInfo } from '../../src/model';
import { styleFor } from '../../src/routing/pathNormalize';
import type { ProcInfo } from '../../src/routing/processTree';
import { Router, type RouteResult, type UnmatchedPolicy } from '../../src/routing/router';

const APP = '/Applications/Visual Studio Code.app';
const PTY = `${APP}/Contents/Frameworks/Code Helper.app/Contents/MacOS/Code Helper`;

function win(id: string, over: Partial<WindowInfo> = {}): WindowInfo {
  return { windowId: id, protocol: 1, name: id, extHostPid: 0, folders: [], focused: false, active: false, lastFocusedAt: 0, terminals: [], ...over };
}

/** Process tree: claude 900 → zsh 800 (terminal of window A) → pty host 700; claude 950 → ext host 500; claude 990 → iTerm zsh 980. */
const PROCS: ProcInfo[] = [
  { pid: 900, ppid: 800, comm: 'claude' },
  { pid: 800, ppid: 700, comm: '/bin/zsh' },
  { pid: 700, ppid: 600, comm: PTY },
  { pid: 950, ppid: 500, comm: 'claude' },
  { pid: 500, ppid: 600, comm: `${APP}/Contents/Frameworks/Code Helper (Plugin).app/Contents/MacOS/Code Helper (Plugin)` },
  { pid: 600, ppid: 1, comm: `${APP}/Contents/MacOS/Electron` },
  { pid: 960, ppid: 810, comm: 'claude' },
  { pid: 810, ppid: 700, comm: '/bin/zsh' }, // a VS Code terminal no window has registered (yet)
  { pid: 990, ppid: 980, comm: 'claude' },
  { pid: 980, ppid: 970, comm: '/bin/zsh' },
  { pid: 970, ppid: 1, comm: '/Applications/iTerm.app/Contents/MacOS/iTerm2' },
];

function chainOf(pid: number): ProcInfo[] {
  const out: ProcInfo[] = [];
  for (let p = PROCS.find((x) => x.pid === pid); p; p = PROCS.find((x) => x.pid === p!.ppid)) out.push(p);
  return out;
}

function makeRouter(unmatched: UnmatchedPolicy = 'ignore') {
  const lookups: number[] = [];
  const router = new Router({
    style: styleFor('darwin'),
    vscodeAppPath: APP,
    unmatched: () => unmatched,
    ancestry: async (pid) => {
      lookups.push(pid);
      return chainOf(pid);
    },
  });
  router.upsertWindow(win('A', { folders: ['/Users/t/code/app'], terminals: [{ shellPid: 800, name: 'zsh' }], extHostPid: 501, lastFocusedAt: 10 }));
  router.upsertWindow(win('B', { folders: ['/Users/t/code/app/packages/web', '/Users/t/notes'], extHostPid: 500, lastFocusedAt: 20 }));
  return { router, lookups };
}

let seq = 0;
function ev(over: { session?: string; cwd?: string; window?: string; pid?: number; entrypoint?: string; hook?: string } = {}): BeaconEvent {
  return normalize(
    { session_id: over.session ?? `s${seq++}`, hook_event_name: over.hook ?? 'Stop', cwd: over.cwd ?? '/elsewhere' },
    {
      'x-cc-beacon-window': over.window ?? '',
      'x-cc-beacon-entrypoint': over.entrypoint ?? 'cli',
      'x-cc-beacon-claude-pid': over.pid ? String(over.pid) : '',
    },
    0,
  )!;
}

const ok = (r: RouteResult) => {
  if ('dropped' in r) throw new Error(`dropped: ${r.dropped}`);
  return r;
};

describe('router', () => {
  it('routes by window header', async () => {
    const r = ok(await makeRouter().router.route(ev({ window: 'B' })));
    expect(r.windowId).toBe('B');
    expect(r.routed.via).toBe('header');
  });

  it('finds the exact terminal through CLAUDE_PID ancestry, even with a header', async () => {
    const r = ok(await makeRouter().router.route(ev({ window: 'A', pid: 900 })));
    expect(r.routed).toMatchObject({ via: 'header', terminalShellPid: 800 });
  });

  it('routes a terminal that predates the env var by ancestry', async () => {
    const r = ok(await makeRouter().router.route(ev({ pid: 900 })));
    expect(r).toMatchObject({ windowId: 'A', routed: { via: 'ancestry', terminalShellPid: 800 } });
  });

  it('routes a panel session by its extension host', async () => {
    const r = ok(await makeRouter().router.route(ev({ pid: 950, entrypoint: 'claude-vscode' })));
    expect(r).toMatchObject({ windowId: 'B', routed: { via: 'ancestry' } });
    expect(r.routed.terminalShellPid).toBeUndefined();
  });

  it('keeps a session in its window (sticky) and looks up ancestry only once', async () => {
    const { router, lookups } = makeRouter();
    ok(await router.route(ev({ session: 'x', pid: 900 })));
    const second = ok(await router.route(ev({ session: 'x', pid: 900 })));
    expect(second.routed).toMatchObject({ via: 'sticky', terminalShellPid: 800 });
    expect(lookups).toEqual([900]);
  });

  it('lets the header win over a sticky binding (resumed in another window)', async () => {
    const { router } = makeRouter();
    ok(await router.route(ev({ session: 'x', window: 'A' })));
    expect(ok(await router.route(ev({ session: 'x', window: 'B' }))).windowId).toBe('B');
  });

  it('routes by cwd only when the process runs under VS Code (D7)', async () => {
    const { router } = makeRouter();
    expect(ok(await router.route(ev({ pid: 960, cwd: '/Users/t/notes/today' })))).toMatchObject({ windowId: 'B', routed: { via: 'cwd' } });
    expect(await router.route(ev({ pid: 990, cwd: '/Users/t/notes' }))).toEqual({ dropped: 'unmatched' });
    expect(await router.route(ev({ cwd: '/Users/t/notes' }))).toEqual({ dropped: 'unmatched' });
  });

  it('prefers the longest folder match, case-insensitively on macOS', async () => {
    const { router } = makeRouter();
    expect(ok(await router.route(ev({ pid: 960, cwd: '/Users/T/Code/App/packages/web/src' }))).windowId).toBe('B');
    expect(ok(await router.route(ev({ pid: 960, cwd: '/users/t/code/app/packages/api' }))).windowId).toBe('A');
  });

  it('breaks folder ties by most recent focus', async () => {
    const { router } = makeRouter();
    router.upsertWindow(win('C', { folders: ['/Users/t/notes'], lastFocusedAt: 99 }));
    expect(ok(await router.route(ev({ pid: 960, cwd: '/Users/t/notes' }))).windowId).toBe('C');
  });

  it('reports the matched folder for the project label', async () => {
    const r = ok(await makeRouter().router.route(ev({ window: 'B', cwd: '/Users/t/code/app/packages/web/src' })));
    expect(r.routed.folder).toBe('/Users/t/code/app/packages/web');
  });

  it('applies the unmatched policy', async () => {
    expect(await makeRouter('ignore').router.route(ev({ pid: 990 }))).toEqual({ dropped: 'unmatched' });
    expect(ok(await makeRouter('lastFocusedWindow').router.route(ev({ pid: 990 })))).toMatchObject({ windowId: 'B', routed: { via: 'lastFocused' } });
  });

  it('ignores headless sessions', async () => {
    expect(await makeRouter().router.route(ev({ window: 'A', entrypoint: 'sdk-cli' }))).toEqual({ dropped: 'entrypoint sdk-cli' });
  });

  it('re-routes when the bound window goes away', async () => {
    const { router } = makeRouter();
    ok(await router.route(ev({ session: 'x', window: 'A', cwd: '/Users/t/notes', pid: 960 })));
    router.removeWindow('A');
    expect(ok(await router.route(ev({ session: 'x', cwd: '/Users/t/notes', pid: 960 })))).toMatchObject({ windowId: 'B', routed: { via: 'cwd' } });
  });

  it('forgets the binding on SessionEnd', async () => {
    const { router } = makeRouter();
    ok(await router.route(ev({ session: 'x', window: 'A' })));
    ok(await router.route(ev({ session: 'x', window: 'A', hook: 'SessionEnd' })));
    expect(router.bindingList()).toEqual([]);
  });
});
