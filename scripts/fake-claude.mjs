// Sends Claude Code hook events to the CC Beacon hub, like the installed curl hook would.
//
//   node scripts/fake-claude.mjs <scenario|run> [options]
//
// Scenarios: permission-approved, permission-denied, permission-ignored, question, long-turn,
//            stop-failure, elicitation, idle-reminder
// Runs:      command-run, panel-run, interactive-run, vscode-terminal-run (recorded in Phase 0)
//
// Options:
//   --window <id>     X-CC-Beacon-Window (CC_BEACON_WINDOW of the target window; see Diagnose)
//   --windows a,b,c   one window per concurrent session (with --sessions)
//   --sessions <n>    run n sessions concurrently            --count <n>  run n times in a row
//   --cwd <dir>       cwd reported by the fake session        --pid <n>    X-CC-Beacon-Claude-Pid
//   --entrypoint <e>  cli (default) or claude-vscode          --speed <x>  time scale (2 = twice as fast)
//   --end             send SessionEnd 1 s after the scenario   --port <n>, --token <t>
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const name = args[0];
const opt = (k, d) => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : d;
};
const flag = (k) => args.includes(`--${k}`);

if (!name || name.startsWith('--')) {
  console.error(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(0, 17).join('\n'));
  process.exit(2);
}

const port = Number(opt('port', 48812 + ((process.getuid?.() ?? 0) % 100)));
const token = opt('token') ?? fs.readFileSync(path.join(os.homedir(), '.cc-beacon', 'token'), 'utf8').trim();
const speed = Number(opt('speed', '1'));
const cwd = opt('cwd', process.cwd());
const pid = opt('pid', '');
const entrypoint = opt('entrypoint', 'cli');
const count = Number(opt('count', '1'));
const sessions = Number(opt('sessions', '1'));
const windows = (opt('windows') ?? opt('window', '')).split(',');

const bash = { tool_name: 'Bash', tool_input: { command: 'npm test', description: 'Run the test suite' } };
const ask = {
  tool_name: 'AskUserQuestion',
  tool_input: { questions: [{ question: 'Should I also update the changelog?', header: 'Changelog', options: [], multiSelect: false }] },
};

/** [ms, hook, extra fields] */
const SCENARIOS = {
  'permission-approved': [[0, 'UserPromptSubmit'], [1500, 'PermissionRequest', bash], [4000, 'PostToolUse', bash], [6000, 'Stop', { last_assistant_message: 'All 42 tests pass.' }]],
  'permission-denied': [[0, 'UserPromptSubmit'], [1500, 'PermissionRequest', bash]],
  'permission-ignored': [[0, 'UserPromptSubmit'], [1500, 'PermissionRequest', bash], [7500, 'Notification', { notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' }]],
  question: [[0, 'UserPromptSubmit'], [1000, 'PermissionRequest', ask]],
  'long-turn': [[0, 'UserPromptSubmit'], [25_000, 'Stop', { last_assistant_message: 'I refactored the parser and **all tests pass**. Want me to open a PR?' }]],
  'stop-failure': [[0, 'UserPromptSubmit'], [2000, 'StopFailure', { error: { type: 'overloaded_error', message: 'Overloaded' } }]],
  elicitation: [[0, 'UserPromptSubmit'], [1000, 'Notification', { notification_type: 'elicitation_dialog', message: 'The GitHub MCP server needs a repository name' }]],
  'idle-reminder': [[0, 'UserPromptSubmit'], [25_000, 'Stop', { last_assistant_message: 'Done. The build is green.' }], [85_000, 'Notification', { notification_type: 'idle_prompt', message: 'Claude is waiting for your input' }]],
};

function loadRun(run) {
  const file = path.join(root, 'packages/core/test/fixtures/runs', `${run}.jsonl`);
  const recs = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const t0 = recs[0].receivedAtMs;
  return recs.map((r) => [r.receivedAtMs - t0, r.body.hook_event_name, r.body, r.headers['x-cc-beacon-entrypoint']]);
}

const steps = SCENARIOS[name] ?? (fs.existsSync(path.join(root, 'packages/core/test/fixtures/runs', `${name}.jsonl`)) ? loadRun(name) : undefined);
if (!steps) {
  console.error(`Unknown scenario or run: ${name}. Scenarios: ${Object.keys(SCENARIOS).join(', ')}`);
  process.exit(2);
}

function post(body, window, ep) {
  const data = JSON.stringify(body);
  return new Promise((resolve) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: '/cc-beacon/v1/hook',
        agent: false,
        timeout: 2000,
        headers: {
          'Content-Type': 'application/json',
          'X-CC-Beacon-Token': token,
          'X-CC-Beacon-Window': window,
          'X-CC-Beacon-Entrypoint': ep,
          'X-CC-Beacon-Claude-Pid': pid,
          'Content-Length': Buffer.byteLength(data),
        },
      },
      (res) => {
        res.resume();
        resolve(res.statusCode);
      },
    );
    req.on('timeout', () => req.destroy());
    req.on('error', (e) => resolve(e.code ?? String(e)));
    req.end(data);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runSession(index) {
  const window = windows[index % windows.length] ?? '';
  const sessionId = `fake-${randomUUID()}`;
  // Recorded runs can hold several sessions; map each to its own fresh id.
  const ids = new Map();
  const promptId = randomUUID();
  const all = flag('end') ? [...steps, [steps.at(-1)[0] + 1000, 'SessionEnd', { reason: 'other' }]] : steps;
  const start = Date.now();
  for (const [at, hook, extra = {}, recordedEp] of all) {
    const wait = start + at / speed - Date.now();
    if (wait > 0) await sleep(wait);
    const orig = extra.session_id;
    const sid = orig ? (ids.get(orig) ?? ids.set(orig, `fake-${randomUUID()}`).get(orig)) : sessionId;
    const body = { prompt_id: promptId, ...extra, session_id: sid, cwd, hook_event_name: hook };
    const status = await post(body, window, recordedEp ?? entrypoint);
    const sub = body.notification_type ?? body.tool_name ?? '';
    console.log(`${new Date().toISOString().slice(11, 23)} ${sid.slice(0, 13)} ${hook}${sub ? ` (${sub})` : ''} → ${status}`);
  }
}

for (let i = 0; i < count; i++) {
  await Promise.all(Array.from({ length: sessions }, (_, s) => runSession(s)));
  if (i < count - 1) await sleep(Number(opt('gap', '300')));
}
