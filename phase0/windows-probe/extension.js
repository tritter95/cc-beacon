// Phase 0 Windows probe. Logs to %USERPROFILE%\.cc-beacon-phase0-probe.log, one JSON object per line:
//  - window identity, VS Code's AUMID, and Mark-of-the-Web on the files VS Code extracted from the VSIX
//  - a Windows PowerShell 5.1 toast worker spawned from the extension host with -File
//  - which window handles a toast click (vscode:// URI with windowId) and whether it comes to the front
//  - the hook test in hooktest.js; payloads are saved to %USERPROFILE%\cc-beacon-phase0-fixtures\
const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');
const hooktest = require('./hooktest');

const LOG = path.join(os.homedir(), '.cc-beacon-phase0-probe.log');
const FIXTURES = path.join(os.homedir(), 'cc-beacon-phase0-fixtures');
const POWERSHELL_AUMID = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe';

let windowLabel = 'unknown';
let aumid = null;
let worker = null;
let recorder = null;
const checkedClaudePids = new Set();

function log(event, data = {}) {
  const line = JSON.stringify({ t: new Date().toISOString(), window: windowLabel, pid: process.pid, event, ...data });
  fs.appendFileSync(LOG, line + '\n');
}

// Mark-of-the-Web is a Zone.Identifier alternate data stream; null means the file has none.
function motw(file) {
  try {
    return fs.readFileSync(file + ':Zone.Identifier', 'utf8').replace(/\r?\n/g, ' ').trim();
  } catch {
    return null;
  }
}

async function terminalPids() {
  return Promise.all(vscode.window.terminals.map(async (t) => ({ name: t.name, pid: await t.processId })));
}

// --- toast worker ---

function startWorker(context) {
  if (worker) return worker;
  const script = path.join(context.extensionPath, 'bin', 'toast-worker.ps1');
  const exe = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const started = Date.now();
  const child = spawn(exe, ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', script, '-AppId', aumid ?? ''],
    { windowsHide: true });
  log('worker.spawn', { exe, script, motw: motw(script) });

  const pending = [];
  let resolveReady;
  const self = {
    ready: new Promise((r) => { resolveReady = r; }),
    request(req) {
      return new Promise((resolve) => {
        pending.push({ resolve, sent: Date.now() });
        child.stdin.write(JSON.stringify(req) + '\n');
      });
    },
  };
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    let reply;
    try {
      reply = JSON.parse(line);
    } catch {
      reply = { ok: false, unparsed: line };
    }
    if (reply.op === 'hello') {
      log('worker.hello', { spawnToHelloMs: Date.now() - started, ...reply });
      resolveReady(reply);
      return;
    }
    const p = pending.shift();
    log('worker.reply', { roundTripMs: p ? Date.now() - p.sent : null, ...reply });
    p?.resolve(reply);
  });
  child.stderr.on('data', (d) => log('worker.stderr', { text: String(d).trim() }));
  child.on('error', (e) => log('worker.error', { error: String(e) }));
  child.on('exit', (code) => {
    log('worker.exit', { code, afterMs: Date.now() - started });
    resolveReady({ ok: false, op: 'hello', error: `worker exited with code ${code}` });
    for (const p of pending.splice(0)) p.resolve({ ok: false, error: 'worker exited' });
    if (worker === self) worker = null;
  });
  worker = self;
  return self;
}

async function clickUri(context, kind) {
  const label = windowLabel.replace(/[^\w.-]/g, '_');
  const raw = vscode.Uri.parse(`${vscode.env.uriScheme}://${context.extension.id}/focus?w=${label}&kind=${kind}&t=${Date.now()}`);
  return (await vscode.env.asExternalUri(raw)).toString(true);
}

async function toast(context, kind, fields) {
  if (process.platform !== 'win32') {
    vscode.window.showErrorMessage('CC Beacon Win Probe: toasts are Windows-only.');
    return null;
  }
  const w = startWorker(context);
  const hello = await w.ready;
  if (!hello.ok || !hello.winrt) {
    vscode.window.showErrorMessage(`CC Beacon Win Probe: the toast worker isn't usable (${hello.error ?? hello.winrtError ?? 'no WinRT'}). See the log.`);
    return null;
  }
  const tag = `${kind}-${Date.now()}`;
  const launch = await clickUri(context, kind);
  log('toast.request', { kind, tag, launch, appId: fields.appId ?? aumid });
  const reply = await w.request({ op: 'show', tag, launch, ...fields });
  if (!reply.ok) vscode.window.showErrorMessage(`CC Beacon Win Probe: toast failed: ${reply.error}`);
  return reply.ok ? tag : null;
}

// --- hook test ---

async function onHookRecord(rec) {
  log('hook', rec);
  if (!rec.claudePid || checkedClaudePids.has(rec.claudePid) || !worker) return;
  checkedClaudePids.add(rec.claudePid);
  // The parent of CLAUDE_PID should be a terminal's shell (CLI) or this extension host (panel).
  const parents = await worker.request({ op: 'parents', pid: Number(rec.claudePid) });
  log('hook.claudeProcess', { claudePid: rec.claudePid, entrypoint: rec.entrypoint, chain: parents.chain,
    terminals: await terminalPids(), extensionHostPid: process.pid });
}

async function hookStart(context) {
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!folder) {
    vscode.window.showErrorMessage('CC Beacon Win Probe: open an empty test folder first.');
    return;
  }
  if (!recorder) {
    try {
      recorder = await hooktest.startRecorder(FIXTURES, (rec) => onHookRecord(rec));
    } catch (e) {
      log('hook.listenError', { error: String(e) });
      vscode.window.showErrorMessage(`CC Beacon Win Probe: can't listen on port ${hooktest.PORT}: ${e}. Is the hook test running in another window?`);
      return;
    }
  }
  if (process.platform === 'win32') startWorker(context);
  const file = hooktest.installHooks(folder);
  // New terminals get CC_BEACON_WINDOW. Claude panel sessions are started by the Claude extension in this
  // same extension host process, so setting process.env tests whether they inherit it too.
  context.environmentVariableCollection.replace('CC_BEACON_WINDOW', windowLabel);
  process.env.CC_BEACON_WINDOW = windowLabel;
  log('hook.start', { folder, file, port: hooktest.PORT, terminals: await terminalPids(), path: process.env.PATH });
  vscode.window.showInformationMessage(`CC Beacon Win Probe: hooks written to ${file} and listening on ${hooktest.PORT}. Open a NEW terminal and run claude.`);
}

function hookStopListener() {
  recorder?.close();
  recorder = null;
  log('hook.stopListener');
  vscode.window.showInformationMessage('CC Beacon Win Probe: stopped listening. The hooks are still installed: send Claude another prompt and watch for hook errors.');
}

function hookRemove(context) {
  hookStopListener();
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const result = folder ? hooktest.removeHooks(folder) : 'no folder';
  context.environmentVariableCollection.delete('CC_BEACON_WINDOW');
  delete process.env.CC_BEACON_WINDOW;
  log('hook.remove', { folder, result });
  vscode.window.showInformationMessage(`CC Beacon Win Probe: hook test removed (${result}).`);
}

// --- activation ---

async function activate(context) {
  windowLabel = vscode.workspace.name ?? 'empty-window';
  try {
    aumid = JSON.parse(fs.readFileSync(path.join(vscode.env.appRoot, 'product.json'), 'utf8')).win32AppUserModelId ?? null;
  } catch (e) {
    log('productJsonError', { error: String(e) });
  }
  const ext = context.extensionPath;
  log('activate', {
    platform: process.platform, vscodeVersion: vscode.version, appRoot: vscode.env.appRoot, aumid,
    remoteName: vscode.env.remoteName ?? null, ppid: process.ppid, extensionPath: ext, isTrusted: vscode.workspace.isTrusted,
    windowState: { focused: vscode.window.state.focused, active: vscode.window.state.active },
    motw: {
      'bin/toast-worker.ps1': motw(path.join(ext, 'bin', 'toast-worker.ps1')),
      'extension.js': motw(path.join(ext, 'extension.js')),
      'package.json': motw(path.join(ext, 'package.json')),
    },
    clickUriSample: await clickUri(context, 'sample'),
    terminals: await terminalPids(),
  });

  context.subscriptions.push(
    vscode.window.onDidChangeWindowState((s) => log('windowState', { focused: s.focused, active: s.active })),
    vscode.window.registerUriHandler({
      handleUri(uri) {
        log('uri.handled', { uri: uri.toString(true), focusedAtHandle: vscode.window.state.focused });
        // Foreground or only a taskbar flash? Check focus again once Windows has had time to decide.
        setTimeout(() => log('uri.focusAfter1500ms', { focused: vscode.window.state.focused }), 1500);
        vscode.window.showInformationMessage(`CC Beacon Win Probe: toast click handled by window "${windowLabel}"`);
      },
    }),
    vscode.commands.registerCommand('ccbWinProbe.toast', () => toast(context, 'click', {
      title: `CC Beacon test 1 (${windowLabel})`,
      body: 'Switch to another window first, then click me: this window should come to the front.',
    })),
    vscode.commands.registerCommand('ccbWinProbe.persistent', async () => {
      const tag = await toast(context, 'persistent', {
        title: 'CC Beacon test 2 (persistent)', body: 'Should stay on screen until withdrawn in 20 s.', persistent: true,
      });
      if (tag) setTimeout(() => worker?.request({ op: 'remove', tag }), 20000);
    }),
    vscode.commands.registerCommand('ccbWinProbe.fallbackToast', () => toast(context, 'fallback', {
      title: 'CC Beacon test 3 (PowerShell identity)', body: 'Fallback for installs without a Start Menu shortcut.',
      appId: POWERSHELL_AUMID,
    })),
    vscode.commands.registerCommand('ccbWinProbe.hookStart', () => hookStart(context)),
    vscode.commands.registerCommand('ccbWinProbe.hookStopListener', hookStopListener),
    vscode.commands.registerCommand('ccbWinProbe.hookRemove', () => hookRemove(context)),
    vscode.commands.registerCommand('ccbWinProbe.openLog', () => vscode.window.showTextDocument(vscode.Uri.file(LOG))),
    { dispose: () => { recorder?.close(); worker?.request({ op: 'exit' }); } },
  );
}

module.exports = { activate, deactivate() {} };
