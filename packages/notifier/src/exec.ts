import { execFile } from 'node:child_process';

export interface ExecResult {
  /** Exit code, or null if the process didn't exit normally. */
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** Set when the process couldn't be started (ENOENT, EACCES, ...). */
  spawnError?: string;
}

/** Runs a program without a shell and never rejects; the outcome is described by the result. */
export function run(file: string, args: string[], timeoutMs: number): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs, encoding: 'utf8', maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (!err) {
        resolve({ code: 0, signal: null, stdout, stderr, timedOut: false });
        return;
      }
      const e = err as NodeJS.ErrnoException & { killed?: boolean; signal?: NodeJS.Signals | null; code?: string | number };
      if (typeof e.code === 'string') {
        resolve({ code: null, signal: null, stdout: '', stderr: '', timedOut: false, spawnError: `${e.code}: ${e.message}` });
        return;
      }
      resolve({
        code: typeof e.code === 'number' ? e.code : null,
        signal: e.signal ?? null,
        stdout: stdout ?? '',
        stderr: stderr ?? '',
        timedOut: Boolean(e.killed) && e.signal === 'SIGTERM',
      });
    });
  });
}

/** A short description of why a run failed, for logs and Diagnose. */
export function describeFailure(r: ExecResult): string {
  if (r.spawnError) return r.spawnError;
  if (r.timedOut) return 'timed out';
  if (r.signal) return `killed by ${r.signal}`;
  const detail = r.stderr.trim().split('\n').pop() ?? '';
  return `exit ${r.code}${detail ? `: ${detail}` : ''}`;
}
