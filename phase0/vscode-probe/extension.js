// Phase 0 probe. Logs to ~/.cc-beacon-phase0-probe.log:
//  - window identity, focus/active state changes, process ids, product.json fields
//  - what env.asExternalUri returns for our vscode:// URI (expect a windowId parameter)
//  - which window handles a URI when a notification is clicked
// URI paths: /notify (post a test notification targeting this window), /focus (click target).
const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const LOG = path.join(os.homedir(), '.cc-beacon-phase0-probe.log');
const HELPER = '/Users/todd/Documents/GitHub/cc-beacon/phase0/mac-helper/build/CCBeaconNotifier.app/Contents/MacOS/ccbeacon-notifier';

let windowLabel = 'unknown';
function log(event, data = {}) {
  const line = JSON.stringify({ t: new Date().toISOString(), window: windowLabel, pid: process.pid, event, ...data });
  fs.appendFileSync(LOG, line + '\n');
}

async function postNotification(context) {
  const t = Date.now();
  const raw = vscode.Uri.parse(`${vscode.env.uriScheme}://${context.extension.id}/focus?w=${encodeURIComponent(windowLabel)}&t=${t}`);
  const external = await vscode.env.asExternalUri(raw);
  const clickUri = external.toString(true);
  log('notify.request', { raw: raw.toString(true), clickUri });
  const started = Date.now();
  execFile(HELPER, ['post', '--id', `probe-${t}`, '--thread', windowLabel, '--title', `CC Beacon probe`,
    '--subtitle', `Window: ${windowLabel}`, '--body', 'Click me: this window should come to the front.', '--open', clickUri],
  (err, stdout, stderr) => {
    log('notify.result', { ms: Date.now() - started, err: err ? String(err) : null, stdout: stdout.trim(), stderr: stderr.trim() });
  });
}

function activate(context) {
  const folders = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
  windowLabel = vscode.workspace.name ?? 'empty-window';
  // Claude panel sessions are spawned by the Claude extension in this same extension host process:
  // do they inherit a variable we set here?
  process.env.CC_BEACON_WINDOW = `probe-${windowLabel}`;

  let product = {};
  try {
    product = JSON.parse(fs.readFileSync(path.join(vscode.env.appRoot, 'product.json'), 'utf8'));
  } catch (e) {
    product = { error: String(e) };
  }
  log('activate', {
    vscodeVersion: vscode.version, uriScheme: vscode.env.uriScheme, appName: vscode.env.appName,
    appRoot: vscode.env.appRoot, remoteName: vscode.env.remoteName ?? null, sessionId: vscode.env.sessionId,
    ppid: process.ppid, execPath: process.execPath, folders,
    product: { nameShort: product.nameShort, darwinBundleIdentifier: product.darwinBundleIdentifier,
      win32AppUserModelId: product.win32AppUserModelId, urlProtocol: product.urlProtocol },
    windowState: { focused: vscode.window.state.focused, active: vscode.window.state.active },
    extensionKind: context.extension.extensionKind,
    ccBeaconWindowEnv: process.env.CC_BEACON_WINDOW,
  });

  context.subscriptions.push(
    vscode.window.onDidChangeWindowState((s) => log('windowState', { focused: s.focused, active: s.active })),
    vscode.window.registerUriHandler({
      handleUri(uri) {
        log('uri.handled', { uri: uri.toString(true), focusedAtHandle: vscode.window.state.focused });
        if (uri.path === '/notify') {
          postNotification(context);
        } else {
          vscode.window.showInformationMessage(`CC Beacon probe: notification click handled by window "${windowLabel}"`);
        }
      },
    }),
    vscode.commands.registerCommand('ccbProbe.notify', () => postNotification(context)),
    vscode.window.onDidStartTerminalShellExecution((e) =>
      log('shellExec.start', { terminal: e.terminal.name, cmd: e.execution.commandLine.value, cwd: e.execution.cwd?.fsPath })),
  );
  // Test setup: if the marker file exists, open the folder it names in a second window
  // (opened from inside the Extension Development Host, so it also gets the probe).
  const marker = path.join(os.homedir(), '.cc-beacon-phase0-open-second');
  if (fs.existsSync(marker)) {
    const target = fs.readFileSync(marker, 'utf8').trim();
    fs.unlinkSync(marker);
    log('openSecondWindow', { target });
    vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(target), { forceNewWindow: true });
  }

  // Terminal shell PIDs, for matching CLAUDE_PID's parent process later.
  Promise.all(vscode.window.terminals.map(async (t) => ({ name: t.name, pid: await t.processId })))
    .then((terms) => log('terminals', { terms }));
}

module.exports = { activate, deactivate() {} };
