// Loads recorded hook runs (Phase 0) and synthetic payloads from test/fixtures/runs/.
import fs from 'node:fs';
import path from 'node:path';
import { normalize } from '../../src/claude/normalize';
import type { BeaconEvent } from '../../src/model';

export interface RawRecord {
  receivedAtMs: number;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

const dir = path.join(__dirname, '..', 'fixtures', 'runs');

export function loadRun(name: string): RawRecord[] {
  return fs
    .readFileSync(path.join(dir, `${name}.jsonl`), 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as RawRecord);
}

/** Normalized events with times relative to the first record, in ms. */
export function loadEvents(name: string): { t: number; ev: BeaconEvent }[] {
  const recs = loadRun(name);
  const t0 = recs[0]?.receivedAtMs ?? 0;
  return recs.flatMap((r) => {
    const ev = normalize(r.body, r.headers, r.receivedAtMs - t0);
    return ev ? [{ t: r.receivedAtMs - t0, ev }] : [];
  });
}

export const RUNS = ['command-run', 'panel-run', 'interactive-run', 'vscode-terminal-run', 'synthetic'];
