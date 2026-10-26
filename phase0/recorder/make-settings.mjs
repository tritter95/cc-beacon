// Phase 0: prints a Claude Code settings JSON that sends every relevant hook event to the recorder.
// Usage: node make-settings.mjs [port] [--env-dump] [--mode=http|command] > hooks.settings.json
import path from 'node:path';

const port = Number(process.argv[2] ?? 48899);
const envDump = process.argv.includes('--env-dump');
const mode = (process.argv.find((a) => a.startsWith('--mode=')) ?? '--mode=http').slice(7);
const envDumpScript = path.join(path.dirname(new URL(import.meta.url).pathname), 'env-dump.sh');

const http = {
  type: 'http',
  url: `http://127.0.0.1:${port}/cc-beacon/v1/hook`,
  timeout: 3,
  headers: {
    'X-CC-Beacon-Token': 'phase0-literal-token',
    'X-CC-Beacon-Window': '$CC_BEACON_WINDOW',
    'X-CC-Beacon-Entrypoint': '$CLAUDE_CODE_ENTRYPOINT',
    'X-CC-Beacon-Claude-Pid': '$CLAUDE_PID',
  },
  allowedEnvVars: ['CC_BEACON_WINDOW', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_PID'],
};
const cmd = { type: 'command', command: `sh '${envDumpScript}'`, timeout: 5 };

// Command-hook variant: forwards stdin to the server and always exits 0, so a missing
// server never shows a hook error. Command hooks can also see CLAUDE_PID.
const curlForward = {
  type: 'command',
  command:
    `curl -s -o /dev/null --noproxy '*' --connect-timeout 1 -m 2 -X POST -H 'Content-Type: application/json' ` +
    `-H 'X-CC-Beacon-Token: phase0-literal-token' -H "X-CC-Beacon-Window: $CC_BEACON_WINDOW" ` +
    `-H "X-CC-Beacon-Entrypoint: $CLAUDE_CODE_ENTRYPOINT" -H "X-CC-Beacon-Claude-Pid: $CLAUDE_PID" ` +
    `--data-binary @- http://127.0.0.1:${port}/cc-beacon/v1/hook >/dev/null 2>&1; exit 0`,
  timeout: 5,
};
const forward = mode === 'command' ? curlForward : http;

const events = [
  'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'PermissionDenied',
  'PostToolUse', 'PostToolUseFailure', 'Notification', 'Stop', 'StopFailure',
  'SubagentStop', 'Elicitation', 'SessionEnd',
];
const hooks = {};
for (const ev of events) {
  const handlers = [ev === 'PostToolUse' && mode === 'command' ? { ...forward, async: true } : forward];
  if (envDump && ['SessionStart', 'Notification', 'Stop'].includes(ev)) handlers.push(cmd);
  hooks[ev] = [{ hooks: handlers }];
}
process.stdout.write(JSON.stringify({ hooks }, null, 2) + '\n');
