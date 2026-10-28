// CLAUDE_PID ancestry: the parent of a CLI session's claude is its terminal's shell (Phase 0 row 4b).
// One `ps` snapshot is walked in memory; results are cached per pid.
import { execFile } from 'node:child_process';

export interface ProcInfo {
  pid: number;
  ppid: number;
  /** Executable path (macOS ps prints the full path for app processes). */
  comm: string;
}

export type Snapshot = () => Promise<ProcInfo[]>;

export function psSnapshot(): Promise<ProcInfo[]> {
  if (process.platform === 'win32') return Promise.resolve([]); // Phase 1b
  return new Promise((resolve) => {
    execFile('ps', ['-A', '-o', 'pid=,ppid=,comm='], { maxBuffer: 8 * 1024 * 1024, timeout: 3000 }, (err, stdout) => {
      resolve(err ? [] : parsePs(stdout));
    });
  });
}

export function parsePs(out: string): ProcInfo[] {
  const procs: ProcInfo[] = [];
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (m) procs.push({ pid: Number(m[1]), ppid: Number(m[2]), comm: m[3].trim() });
  }
  return procs;
}

/** pid itself first, then its parent, grandparent, ... up to (not including) launchd/init. */
export function ancestry(pid: number, procs: ProcInfo[], max = 32): ProcInfo[] {
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const chain: ProcInfo[] = [];
  let cur = byPid.get(pid);
  while (cur && chain.length < max && !chain.includes(cur)) {
    chain.push(cur);
    if (cur.ppid <= 1) break;
    cur = byPid.get(cur.ppid);
  }
  return chain;
}

export class AncestryCache {
  private cache = new Map<number, { at: number; chain: ProcInfo[] }>();
  private inflight?: Promise<ProcInfo[]>;

  constructor(
    private readonly snapshot: Snapshot = psSnapshot,
    private readonly ttlMs = 10 * 60_000,
  ) {}

  async get(pid: number): Promise<ProcInfo[]> {
    const hit = this.cache.get(pid);
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.chain;
    // Concurrent lookups share one ps run.
    this.inflight ??= this.snapshot().finally(() => (this.inflight = undefined));
    const chain = ancestry(pid, await this.inflight);
    if (this.cache.size > 500) this.cache.clear();
    this.cache.set(pid, { at: Date.now(), chain });
    return chain;
  }
}
