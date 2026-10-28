// Decides which window owns a Claude session (phase1-plan §5.3, D6, D7):
// header → sticky binding → CLAUDE_PID ancestry → cwd (only under VS Code) → unmatched policy.
import type { BeaconEvent, RoutedEvent, RouteVia, WindowInfo } from '../model';
import { isWithin, normalizePath, type PathStyle } from './pathNormalize';
import type { ProcInfo } from './processTree';

export type UnmatchedPolicy = 'ignore' | 'lastFocusedWindow';

export interface RouterOptions {
  style: PathStyle;
  ancestry: (pid: number) => Promise<ProcInfo[]>;
  /** The VS Code app bundle, e.g. "/Applications/Visual Studio Code.app". Ancestors inside it mean "runs under VS Code". */
  vscodeAppPath?: string;
  unmatched: () => UnmatchedPolicy;
  /** Entrypoints never alerted on (headless `claude -p`). */
  ignoreEntrypoints?: string[];
}

interface Registered {
  info: WindowInfo;
  folders: string[]; // normalized
}

interface Binding {
  windowId: string;
  terminalShellPid?: number;
}

export type RouteResult = { windowId: string; routed: RoutedEvent } | { dropped: string };

export class Router {
  private windows = new Map<string, Registered>();
  private bindings = new Map<string, Binding>();

  constructor(private readonly opts: RouterOptions) {}

  upsertWindow(info: WindowInfo): void {
    this.windows.set(info.windowId, { info, folders: info.folders.map((f) => normalizePath(f, this.opts.style)) });
  }

  removeWindow(windowId: string): void {
    this.windows.delete(windowId);
    for (const [key, b] of this.bindings) if (b.windowId === windowId) this.bindings.delete(key);
  }

  windowList(): WindowInfo[] {
    return [...this.windows.values()].map((w) => w.info);
  }

  bindingList(): { session: string; windowId: string; terminalShellPid?: number }[] {
    return [...this.bindings].map(([session, b]) => ({ session, ...b }));
  }

  async route(ev: BeaconEvent): Promise<RouteResult> {
    if (ev.entrypoint && (this.opts.ignoreEntrypoints ?? ['sdk-cli']).includes(ev.entrypoint)) {
      return { dropped: `entrypoint ${ev.entrypoint}` };
    }
    const prev = this.bindings.get(ev.sessionKey);
    let via: RouteVia | undefined;
    let windowId: string | undefined;
    let terminalShellPid: number | undefined;
    let chain: ProcInfo[] | undefined;
    const getChain = async () => (chain ??= ev.claudePid ? await this.opts.ancestry(ev.claudePid) : []);

    if (ev.windowHint && this.windows.has(ev.windowHint)) {
      via = 'header';
      windowId = ev.windowHint;
    } else if (prev && this.windows.has(prev.windowId)) {
      via = 'sticky';
      windowId = prev.windowId;
    } else {
      const hit = this.byAncestry(await getChain());
      if (hit) {
        via = 'ancestry';
        ({ windowId, terminalShellPid } = hit);
      } else if (ev.cwd && this.underVsCode(await getChain())) {
        const w = this.byCwd(ev.cwd);
        if (w) {
          via = 'cwd';
          windowId = w;
        }
      }
      if (!windowId && this.opts.unmatched() === 'lastFocusedWindow') {
        const w = this.lastFocused();
        if (w) {
          via = 'lastFocused';
          windowId = w;
        }
      }
    }
    if (!windowId || !via) return { dropped: 'unmatched' };

    // Find the session's terminal once per binding (needed for click-to-focus and "watching").
    if (prev?.windowId === windowId && prev.terminalShellPid) terminalShellPid = prev.terminalShellPid;
    if (!terminalShellPid && ev.claudePid) terminalShellPid = this.byAncestry(await getChain(), windowId)?.terminalShellPid;

    if (ev.hook === 'SessionEnd') this.bindings.delete(ev.sessionKey);
    else this.bindings.set(ev.sessionKey, { windowId, terminalShellPid });

    return {
      windowId,
      routed: { event: ev, via, terminalShellPid, folder: this.folderIn(windowId, ev.cwd) },
    };
  }

  /** The window whose terminal shell or extension host is an ancestor of the Claude process. */
  private byAncestry(chain: ProcInfo[], onlyWindow?: string): { windowId: string; terminalShellPid?: number } | undefined {
    for (const p of chain.slice(1)) {
      for (const [id, w] of this.windows) {
        if (onlyWindow && id !== onlyWindow) continue;
        if (w.info.terminals.some((t) => t.shellPid === p.pid)) return { windowId: id, terminalShellPid: p.pid };
        if (w.info.extHostPid === p.pid) return { windowId: id };
      }
    }
    return undefined;
  }

  private underVsCode(chain: ProcInfo[]): boolean {
    const app = this.opts.vscodeAppPath;
    if (!app) return false;
    const prefix = app.endsWith('/') ? app : `${app}/`;
    return chain.some((p) => p.comm.startsWith(prefix));
  }

  /** Longest workspace-folder match across windows; ties go to the most recently focused window. */
  private byCwd(cwd: string): string | undefined {
    const c = normalizePath(cwd, this.opts.style);
    let best: { id: string; len: number; focusedAt: number } | undefined;
    for (const [id, w] of this.windows) {
      for (const f of w.folders) {
        if (!isWithin(c, f)) continue;
        const cand = { id, len: f.length, focusedAt: w.info.lastFocusedAt };
        if (!best || cand.len > best.len || (cand.len === best.len && cand.focusedAt > best.focusedAt)) best = cand;
      }
    }
    return best?.id;
  }

  private lastFocused(): string | undefined {
    let best: Registered | undefined;
    for (const w of this.windows.values()) if (!best || w.info.lastFocusedAt > best.info.lastFocusedAt) best = w;
    return best?.info.windowId;
  }

  private folderIn(windowId: string, cwd: string | undefined): string | undefined {
    const w = this.windows.get(windowId);
    if (!w || !cwd) return undefined;
    const c = normalizePath(cwd, this.opts.style);
    let best: number | undefined;
    w.folders.forEach((f, i) => {
      if (isWithin(c, f) && (best === undefined || f.length > w.folders[best].length)) best = i;
    });
    return best === undefined ? undefined : w.info.folders[best];
  }
}
