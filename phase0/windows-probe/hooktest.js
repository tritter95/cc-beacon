// Phase 0 hook test core. No vscode dependency, so it can also be exercised from plain Node on macOS.
// Writes a project-local .claude/settings.local.json whose hooks POST every event to a recorder on
// 127.0.0.1, in two forms side by side, so one run compares them:
//   bash-curl:  the default hook shell (Git Bash on Windows) running curl
//   powershell: "shell": "powershell", forwarding stdin's raw bytes with HttpWebRequest
// Both always exit 0, so a recorder that isn't listening must not surface a hook error.
const fs = require('fs');
const path = require('path');
const http = require('http');

const PORT = Number(process.env.CCB_HOOKTEST_PORT) || 48899;
const HOOK_URL = `http://127.0.0.1:${PORT}/cc-beacon/v1/hook`;
const EVENTS = ['UserPromptSubmit', 'PermissionRequest', 'Notification', 'PostToolUse', 'Stop', 'SessionEnd'];
const BACKUP_SUFFIX = '.ccb-backup';

const bashCurl = {
  type: 'command',
  timeout: 5,
  command:
    `curl -s -o /dev/null --noproxy '*' --connect-timeout 1 -m 2 -X POST -H 'Content-Type: application/json' ` +
    `-H 'X-CCB-Form: bash-curl' -H "X-CCB-Sent: $(date +%s%3N)" -H "X-CC-Beacon-Window: $CC_BEACON_WINDOW" ` +
    `-H "X-CC-Beacon-Entrypoint: $CLAUDE_CODE_ENTRYPOINT" -H "X-CC-Beacon-Claude-Pid: $CLAUDE_PID" ` +
    `--data-binary @- ${HOOK_URL} >/dev/null 2>&1; exit 0`,
};

const powershell = {
  type: 'command',
  shell: 'powershell',
  timeout: 5,
  command: [
    "$ErrorActionPreference = 'SilentlyContinue'",
    '$ms = New-Object IO.MemoryStream',
    '[Console]::OpenStandardInput().CopyTo($ms)',
    '$b = $ms.ToArray()',
    `$r = [Net.HttpWebRequest]::Create('${HOOK_URL}')`,
    "$r.Method = 'POST'",
    '$r.Proxy = $null',
    '$r.Timeout = 2000',
    "$r.ContentType = 'application/json'",
    "$r.Headers.Add('X-CCB-Form', 'powershell')",
    "$r.Headers.Add('X-CCB-Sent', [string][DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())",
    "$r.Headers.Add('X-CC-Beacon-Window', [string]$env:CC_BEACON_WINDOW)",
    "$r.Headers.Add('X-CC-Beacon-Entrypoint', [string]$env:CLAUDE_CODE_ENTRYPOINT)",
    "$r.Headers.Add('X-CC-Beacon-Claude-Pid', [string]$env:CLAUDE_PID)",
    'try { $s = $r.GetRequestStream(); $s.Write($b, 0, $b.Length); $s.Close(); $r.GetResponse().Close() } catch { }',
    'exit 0',
  ].join('; '),
};

function hooksConfig(forms) {
  const hooks = {};
  for (const ev of EVENTS) {
    hooks[ev] = [{ hooks: forms.map((f) => (ev === 'PostToolUse' ? { ...f, async: true } : f)) }];
  }
  return hooks;
}

function settingsFile(folder) {
  return path.join(folder, '.claude', 'settings.local.json');
}

// Backs up an existing settings.local.json once, then replaces only its "hooks" key.
function installHooks(folder, forms = [bashCurl, powershell]) {
  const file = settingsFile(folder);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let settings = {};
  if (fs.existsSync(file)) {
    if (!fs.existsSync(file + BACKUP_SUFFIX)) fs.copyFileSync(file, file + BACKUP_SUFFIX);
    settings = JSON.parse(fs.readFileSync(file, 'utf8'));
  }
  settings.hooks = hooksConfig(forms);
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
  return file;
}

function removeHooks(folder) {
  const file = settingsFile(folder);
  if (fs.existsSync(file + BACKUP_SUFFIX)) {
    fs.renameSync(file + BACKUP_SUFFIX, file);
    return 'restored backup';
  }
  if (fs.existsSync(file)) {
    fs.unlinkSync(file);
    return 'deleted';
  }
  return 'nothing to remove';
}

// Calls onRecord(record) for every hook POST and saves the full payload under fixturesDir.
function startRecorder(fixturesDir, onRecord) {
  let seq = 0;
  const server = http.createServer((req, res) => {
    const receivedMs = Date.now();
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      res.writeHead(204);
      res.end();
      const raw = Buffer.concat(chunks).toString('utf8');
      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        body = { _unparsed: raw.slice(0, 2000) };
      }
      const h = req.headers;
      const sent = Number(h['x-ccb-sent']);
      const rec = {
        seq: ++seq,
        event: body.hook_event_name ?? 'unknown',
        sub: body.notification_type ?? body.tool_name ?? '',
        form: h['x-ccb-form'] ?? 'unknown',
        sentToReceivedMs: Number.isFinite(sent) && sent > 0 ? receivedMs - sent : null,
        receivedMs,
        entrypoint: h['x-cc-beacon-entrypoint'] ?? null,
        claudePid: h['x-cc-beacon-claude-pid'] ?? null,
        beaconWindow: h['x-cc-beacon-window'] ?? null,
        sessionId: body.session_id ?? null,
      };
      fs.mkdirSync(fixturesDir, { recursive: true });
      const name = `${String(rec.seq).padStart(3, '0')}-${rec.event}${rec.sub ? '-' + rec.sub : ''}-${rec.form}.json`;
      fs.writeFileSync(path.join(fixturesDir, name.replace(/[^\w.-]/g, '_')),
        JSON.stringify({ receivedAtMs: receivedMs, headers: h, body }, null, 2));
      onRecord(rec);
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(PORT, '127.0.0.1', () => resolve(server));
  });
}

module.exports = { PORT, bashCurl, powershell, hooksConfig, installHooks, removeHooks, startRecorder };
