// CC Beacon Core: runs next to Claude Code (extensionKind "workspace"). Receives hook events
// through the hub, tracks each session's attention state, and alerts in the window or through
// the Notifier extension. See PLAN.md and docs/phase1-plan.md.
import os from 'node:os';
import path from 'node:path';
import * as vscode from 'vscode';
import { AttentionContext } from './attention/context';
import { Mute } from './attention/mute';
import { decide, type OsWhen, type PolicySettings } from './attention/policy';
import { present } from './attention/present';
import { SessionStore, type Entry } from './attention/sessionStore';
import type { Alert, AlertKind } from './attention/stateMachine';
import { HookInstaller, type HookState } from './claude/hookInstaller';
import { claudeVersion, LatencyStats, managedSettings, renderReport } from './diagnostics';
import { Coordinator, type Role } from './hub/election';
import { defaultPort, PROTOCOL_VERSION } from './hub/protocol';
import { ensureSecrets, type Secrets } from './hub/token';
import type { WindowInfo } from './model';
import { NotifierClient } from './notifierClient';
import { styleFor } from './routing/pathNormalize';
import { AncestryCache } from './routing/processTree';
import type { UnmatchedPolicy } from './routing/router';
import { TerminalTracker } from './routing/terminalTracker';
import { computeWindowId, realpathOr } from './routing/windowIdentity';
import { project } from './ui/labels';
import { pickSession, revealSession } from './ui/reveal';
import { StatusBar } from './ui/statusBar';
import { showToast } from './ui/toasts';

const HOUR = 3600_000;
const TEST_THREAD = 'cc-beacon-test';
const NOTIFIER_ID = 'todd.cc-beacon-notifier';

let coordinator: Coordinator | undefined;

/** What activate() returns. Only the integration test uses it: VS Code has no API to read a status bar item. */
export interface CoreApi {
  statusBarText(): string;
}

export function activate(context: vscode.ExtensionContext): CoreApi {
  const out = vscode.window.createOutputChannel('CC Beacon');
  const log = (m: string) => out.appendLine(`${new Date().toISOString()} ${m}`);
  const version = String(context.extension.packageJSON.version);
  const config = () => vscode.workspace.getConfiguration('ccBeacon');
  const port = () => {
    const p = config().get<number>('port', 0);
    return p > 0 ? p : defaultPort(process.getuid?.(), os.userInfo().username);
  };

  // Window identity, injected so Claude's hooks can name this window (PLAN §4.1).
  const folders = () =>
    (vscode.workspace.workspaceFolders ?? []).filter((f) => f.uri.scheme === 'file').map((f) => realpathOr(f.uri.fsPath));
  const workspaceFile = vscode.workspace.workspaceFile?.scheme === 'file' ? vscode.workspace.workspaceFile.fsPath : undefined;
  const windowId = computeWindowId(vscode.env.remoteName, workspaceFile, folders());
  const env = context.environmentVariableCollection;
  env.persistent = true;
  env.description = 'Lets CC Beacon route Claude Code alerts from this terminal to this window';
  env.replace('CC_BEACON_WINDOW', windowId);
  // Claude panel sessions are spawned in this extension host and inherit this (Phase 0 row 16).
  process.env.CC_BEACON_WINDOW = windowId;

  let secrets: Secrets | undefined;
  let secretsError: string | undefined;
  try {
    secrets = ensureSecrets();
  } catch (e) {
    secretsError = `Can't create ~/.cc-beacon: ${String(e)}`;
    log(secretsError);
  }

  const tracker = new TerminalTracker();
  const attention = new AttentionContext(tracker);
  const mute = new Mute(context.globalState);
  const notifier = new NotifierClient(log);
  const statusBar = new StatusBar();
  const installer = new HookInstaller(port, context.globalState, log);
  const latency = new LatencyStats();
  const ancestry = new AncestryCache();
  let hookState: HookState = installer.status();
  let lastFocusedAt = vscode.window.state.focused ? Date.now() : 0;
  let role: Role = 'starting';
  let roleDetail: string | undefined;
  let driftChecked = false;

  const store = new SessionStore({
    now: Date.now,
    level: (p) => attention.level(p),
    alert: (e, a, receivedAt) => void deliver(e, a, receivedAt),
    withdraw: (e) => notifier.withdraw(e.key),
    changed: () => render(),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (h) => clearTimeout(h as NodeJS.Timeout),
  });

  function problem(): string | undefined {
    if (secretsError) return secretsError;
    if (role === 'error') return roleDetail;
    if (hookState.status === 'invalid') return `Can't read ${hookState.file}`;
    if (hookState.status !== 'ok') return 'Claude Code hooks are not set up';
    if (hookState.disableAllHooks) return 'Claude Code hooks are turned off (disableAllHooks)';
    if (notifier.missing) return 'The CC Beacon Notifier extension is not installed';
    const caps = notifier.caps;
    if (caps?.permission === 'denied') return 'Notifications are turned off for CC Beacon in System Settings';
    if (caps?.permission === 'notDetermined') return 'OS notifications not allowed yet: run Send Test Notification';
    return undefined;
  }

  function render(): void {
    statusBar.render({ entries: store.list(), muted: mute.muted, mutedUntil: mute.until, problem: problem() });
  }

  function policySettings(cfg: vscode.WorkspaceConfiguration): PolicySettings {
    return {
      osWhen: cfg.get<OsWhen>('osNotifications.when', 'away'),
      inWindowToasts: cfg.get('inWindowToasts', true),
      minTurnSeconds: cfg.get('completed.minTurnSeconds', 20),
      alerts: {
        needsInput: cfg.get('alerts.needsInput', true),
        completed: cfg.get('alerts.completed', true),
        failed: cfg.get('alerts.failed', true),
      },
      soundEnabled: cfg.get('sound.enabled', true),
    };
  }

  function soundFor(kind: AlertKind, cfg: vscode.WorkspaceConfiguration, e: Entry): string | null {
    const key = kind === 'failed' ? 'failed' : kind === 'completed' || (kind === 'reminder' && e.s.state === 'done') ? 'completed' : 'needsInput';
    const name = cfg.get<string>(`sound.${key}`, '').trim();
    return name && name !== 'none' ? name : null;
  }

  async function focusUri(pathAndQuery: string): Promise<string> {
    const uri = vscode.Uri.parse(`${vscode.env.uriScheme}://${context.extension.id}${pathAndQuery}`);
    return (await vscode.env.asExternalUri(uri)).toString(true);
  }

  async function deliver(e: Entry, alert: Alert, receivedAt?: number): Promise<void> {
    const cfg = config();
    if (!cfg.get('enabled', true)) return;
    const level = attention.level({ entrypoint: e.s.entrypoint, terminalShellPid: e.terminalShellPid });
    const decision = decide(alert, level, policySettings(cfg), mute.muted);
    log(
      `alert ${alert.kind}/${alert.reason} for ${e.key.slice(0, 8)} at L${level}:` +
        ` ${decision.os ? 'os ' : ''}${decision.toast ? 'toast ' : ''}${decision.sound ? `sound(${decision.sound})` : ''}`,
    );
    if (!decision.os && !decision.toast && !decision.sound) return;
    const p = present(alert, project(e), {
      includeMessage: cfg.get('preview.includeMessage', true),
      maxChars: cfg.get('preview.maxChars', 140),
    });
    const sound = decision.sound ? soundFor(alert.kind, cfg, e) : null;
    const volume = cfg.get('sound.volume', 0.6);

    if (decision.os) {
      const r = await notifier.notify({
        id: `${e.key}:${alert.kind}`,
        threadId: e.key,
        title: p.title,
        subtitle: p.subtitle,
        body: p.body,
        sound,
        clickUri: await focusUri(`/focus?s=${encodeURIComponent(e.key)}`),
        replaceThread: true,
      });
      if (r.delivered) {
        if (receivedAt) latency.add(Date.now() - receivedAt);
        return;
      }
      log(`OS notification not delivered (${r.error ?? 'unknown'}); alerting in the window instead`);
      render();
    }
    if (decision.toast || decision.os) void showToast(alert.kind, p, () => void focusSession(e.key), () => void mute.mute(HOUR));
    if (sound) notifier.playSound(sound, decision.sound === 'soft' ? volume * 0.5 : volume);
  }

  async function focusSession(key: string): Promise<void> {
    let e = store.get(key);
    if (!e) e = await pickSession(store.list());
    if (!e) return;
    if (!(await revealSession(e, tracker, log))) {
      log(`couldn't find where session ${e.key.slice(0, 8)} runs`);
      void vscode.window.showInformationMessage(`CC Beacon: couldn't find the terminal for "${project(e)}".`);
    }
    store.ack(e.key);
  }

  // Hub election and window registration.
  const appRoot = vscode.env.appRoot;
  const appBundle = appRoot.includes('.app/') ? appRoot.slice(0, appRoot.indexOf('.app/') + 4) : path.dirname(path.dirname(appRoot));
  const getInfo = (): WindowInfo => ({
    windowId,
    protocol: PROTOCOL_VERSION,
    name: vscode.workspace.name ?? 'Untitled',
    extHostPid: process.pid,
    folders: folders(),
    focused: vscode.window.state.focused,
    active: vscode.window.state.active,
    lastFocusedAt,
    terminals: tracker.terminals(),
  });

  async function startCoordinator(): Promise<void> {
    await coordinator?.stop();
    coordinator = undefined;
    if (!secrets) return render();
    const c = new Coordinator({
      port: port(),
      token: secrets.token,
      version,
      windowId,
      getInfo,
      routerOptions: {
        style: styleFor(process.platform),
        ancestry: (pid) => ancestry.get(pid),
        vscodeAppPath: appBundle,
        unmatched: () => config().get<UnmatchedPolicy>('unmatchedSessions', 'ignore'),
      },
      onEvent: (r) => store.onRouted(r),
      onRole: (r, detail) => {
        role = r;
        roleDetail = detail;
        log(`role: ${r}${detail ? ` (${detail})` : ''}`);
        render();
        if (r === 'hub' && !driftChecked) {
          driftChecked = true;
          void installer.driftCheck().then(refreshHooks);
        }
      },
      log,
      includeMessageText: () => config().get('diagnostics.includeMessageText', false),
    });
    coordinator = c;
    await c.start();
  }

  let updateTimer: NodeJS.Timeout | undefined;
  const scheduleUpdate = () => {
    clearTimeout(updateTimer);
    updateTimer = setTimeout(() => coordinator?.update(), 100);
  };

  const refreshHooks = () => {
    hookState = installer.status();
    render();
  };

  async function sendTestNotification(): Promise<void> {
    const caps = await notifier.probe();
    render();
    if (!caps) {
      void vscode.window.showWarningMessage(
        "CC Beacon: the CC Beacon Notifier extension isn't installed or didn't respond, so alerts stay inside VS Code.",
      );
      return;
    }
    if (caps.permission === 'notDetermined') {
      const ok = await vscode.window.showInformationMessage(
        'macOS will ask whether CC Beacon may show notifications.',
        {
          modal: true,
          detail:
            'Choose Allow, so alerts reach you while VS Code is in the background. If you choose Don\'t Allow, macOS won\'t ask again; you can still turn them on in System Settings › Notifications › CC Beacon.',
        },
        'Continue',
      );
      if (ok !== 'Continue') return;
      const permission = await notifier.requestPermission();
      render();
      if (permission !== 'granted') {
        const pick = await vscode.window.showWarningMessage('CC Beacon: notifications were not allowed.', 'Open System Settings');
        if (pick) notifier.openSettings();
        return;
      }
    } else if (caps.permission === 'denied') {
      const pick = await vscode.window.showWarningMessage(
        'CC Beacon: notifications are turned off for CC Beacon in System Settings.',
        'Open System Settings',
      );
      if (pick) notifier.openSettings();
      return;
    }
    const r = await notifier.notify({
      id: TEST_THREAD,
      threadId: TEST_THREAD,
      title: 'CC Beacon test',
      subtitle: vscode.workspace.name ?? 'VS Code',
      body: 'Click this notification: it should bring this window to the front.',
      sound: config().get<string>('sound.needsInput', 'Glass'),
      clickUri: await focusUri('/test'),
      replaceThread: true,
    });
    render();
    if (r.delivered) {
      void vscode.window.showInformationMessage(
        'CC Beacon: test notification sent. Click it. If VS Code asks whether CC Beacon may open the link, tick "Don\'t ask again" and choose Open.',
      );
    } else {
      void vscode.window.showWarningMessage(`CC Beacon: the test notification wasn't delivered (${r.error ?? 'unknown error'}).`);
    }
  }

  async function diagnose(): Promise<void> {
    const [hubDiag, claude] = await Promise.all([coordinator?.hubDiagnostics(), claudeVersion(), notifier.probe()]);
    refreshHooks();
    const report = renderReport({
      generatedAt: new Date(),
      versions: {
        vscode: vscode.version,
        core: version,
        notifier: vscode.extensions.getExtension(NOTIFIER_ID)?.packageJSON.version,
        claude,
      },
      hub: { role, detail: roleDetail, port: port(), windowId, envWindow: process.env.CC_BEACON_WINDOW, diagnostics: hubDiag },
      hooks: hookState,
      managed: process.platform === 'darwin' ? managedSettings() : undefined,
      notifier: { caps: notifier.caps, missing: notifier.missing },
      entries: store.list(),
      latency: latency.summary(),
      muted: mute.muted,
    });
    const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: report });
    await vscode.window.showTextDocument(doc);
  }

  context.subscriptions.push(
    out,
    tracker,
    attention,
    mute,
    statusBar,
    installer,
    { dispose: () => store.dispose() },
    { dispose: () => clearTimeout(updateTimer) },
    attention.onDidChange(() => store.contextChanged()),
    mute.onDidChange(render),
    tracker.onDidChange(scheduleUpdate),
    vscode.window.onDidChangeWindowState((s) => {
      if (s.focused) {
        lastFocusedAt = Date.now();
        refreshHooks();
      }
      scheduleUpdate();
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(scheduleUpdate),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('ccBeacon.port')) {
        driftChecked = false;
        refreshHooks();
        void startCoordinator();
      } else if (e.affectsConfiguration('ccBeacon')) render();
    }),
    vscode.window.registerUriHandler({
      handleUri(uri) {
        const q = new URLSearchParams(uri.query);
        if (uri.path === '/focus') void focusSession(q.get('s') ?? '');
        else if (uri.path === '/test') {
          notifier.withdraw(TEST_THREAD);
          void vscode.window.showInformationMessage('CC Beacon: click-through works. Alerts will bring you back to the right window.');
        }
      },
    }),
    vscode.commands.registerCommand('ccBeacon.setupHooks', async () => {
      await installer.setup();
      refreshHooks();
    }),
    vscode.commands.registerCommand('ccBeacon.removeHooks', async () => {
      await installer.remove();
      refreshHooks();
    }),
    vscode.commands.registerCommand('ccBeacon.sendTestNotification', sendTestNotification),
    vscode.commands.registerCommand('ccBeacon.mute', () => mute.mute(HOUR)),
    vscode.commands.registerCommand('ccBeacon.unmute', () => mute.unmute()),
    vscode.commands.registerCommand('ccBeacon.showSessions', async () => {
      const e = await pickSession(store.list());
      if (e) await focusSession(e.key);
    }),
    vscode.commands.registerCommand('ccBeacon.focusSession', (key: string) => focusSession(key)),
    vscode.commands.registerCommand('ccBeacon.diagnose', diagnose),
    vscode.commands.registerCommand('ccBeacon.openNotificationSettings', async () => {
      if (!notifier.caps && !(await notifier.probe())) {
        await vscode.env.openExternal(
          vscode.Uri.parse('x-apple.systempreferences:com.apple.Notifications-Settings.extension?id=local.ccbeacon.notifier'),
        );
      } else notifier.openSettings();
    }),
  );

  render();
  void startCoordinator();
  void notifier.probe().then((caps) => {
    render();
    if (!caps && !context.globalState.get('ccBeacon.notifierMissingWarned')) {
      void context.globalState.update('ccBeacon.notifierMissingWarned', true);
      void vscode.window.showWarningMessage(
        "CC Beacon: the CC Beacon Notifier extension isn't installed, so alerts stay inside VS Code. Install cc-beacon-notifier.vsix to get OS notifications.",
      );
    }
  });
  if (!context.globalState.get('ccBeacon.walkthroughShown')) {
    // The walkthrough's first step sets up the hooks; don't also nag about them.
    driftChecked = true;
    void context.globalState.update('ccBeacon.walkthroughShown', true);
    void vscode.commands.executeCommand('workbench.action.openWalkthrough', `${context.extension.id}#setup`, false);
  }
  log(`activated ${version} in window ${windowId} (${vscode.workspace.name ?? 'empty window'}), port ${port()}`);
  return { statusBarText: () => statusBar.text };
}

export async function deactivate(): Promise<void> {
  await coordinator?.stop();
  coordinator = undefined;
}
