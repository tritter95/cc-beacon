// "Set Up / Remove Claude Code Hooks": diff preview, explicit confirmation, backup and atomic
// write (PLAN §4.1). Also the activation-time drift check, run by the hub window only.
import os from 'node:os';
import * as vscode from 'vscode';
import { inspect, withHooks, withoutHooks, type Inspection } from './hookConfig';
import { claudeSettingsPath, readSettings, writeSettings } from './settingsFile';

const SCHEME = 'cc-beacon-preview';
const SNOOZE_KEY = 'ccBeacon.hooksPromptSnoozedUntil';
const SNOOZE_MS = 7 * 24 * 3600_000;

export type HookState = Inspection & { file: string; exists: boolean };

export class HookInstaller implements vscode.Disposable {
  private readonly docs = new Map<string, string>();
  private readonly provider: vscode.Disposable;
  private warnedDisabled = false;

  constructor(
    private readonly port: () => number,
    private readonly state: vscode.Memento,
    private readonly log: (m: string) => void,
  ) {
    this.provider = vscode.workspace.registerTextDocumentContentProvider(SCHEME, {
      provideTextDocumentContent: (uri) => this.docs.get(uri.toString()) ?? '',
    });
  }

  get file(): string {
    return claudeSettingsPath();
  }

  status(): HookState {
    const file = this.file;
    try {
      const { text, exists } = readSettings(file);
      return { ...inspect(text, this.port()), file, exists };
    } catch (e) {
      return { status: 'invalid', disableAllHooks: false, missing: [], outdated: [], error: String(e), file, exists: false };
    }
  }

  setup(): Promise<boolean> {
    return this.change('setup');
  }

  remove(): Promise<boolean> {
    return this.change('remove');
  }

  /** Non-modal nudge when our hooks are missing or stale. One window per machine runs this. */
  async driftCheck(): Promise<void> {
    const st = this.status();
    if (st.status === 'ok') {
      if (st.disableAllHooks) this.warnDisabled();
      return;
    }
    if (this.state.get<number>(SNOOZE_KEY, 0) > Date.now()) return;
    const [message, action] =
      st.status === 'missing'
        ? ["CC Beacon isn't connected to Claude Code yet.", 'Set Up Hooks']
        : st.status === 'invalid'
          ? [`CC Beacon can't read ${tilde(st.file)}: ${st.error}`, 'Open settings.json']
          : ["CC Beacon's Claude Code hooks are out of date.", 'Update Hooks'];
    const pick = await vscode.window.showWarningMessage(message, action, 'Not Now');
    if (pick === 'Not Now') await this.state.update(SNOOZE_KEY, Date.now() + SNOOZE_MS);
    else if (pick === 'Open settings.json') await openFile(st.file);
    else if (pick) await this.setup();
  }

  dispose(): void {
    this.provider.dispose();
  }

  private async change(kind: 'setup' | 'remove'): Promise<boolean> {
    const file = this.file;
    let text: string;
    try {
      text = readSettings(file).text;
    } catch (e) {
      void vscode.window.showErrorMessage(`CC Beacon couldn't read ${tilde(file)}: ${String(e)}`);
      return false;
    }
    const result = kind === 'setup' ? withHooks(text, this.port()) : withoutHooks(text);
    if ('error' in result) {
      const pick = await vscode.window.showErrorMessage(`CC Beacon didn't change ${tilde(file)}: ${result.error}`, 'Open settings.json');
      if (pick) await openFile(file);
      return false;
    }
    if (!result.changed) {
      void vscode.window.showInformationMessage(
        kind === 'setup' ? 'CC Beacon: Claude Code hooks are already set up.' : 'CC Beacon: there are no CC Beacon hooks to remove.',
      );
      return kind === 'setup';
    }

    const stamp = String(Date.now());
    const left = vscode.Uri.from({ scheme: SCHEME, path: '/current/settings.json', query: stamp });
    const right = vscode.Uri.from({ scheme: SCHEME, path: `/${kind === 'setup' ? 'with' : 'without'}-cc-beacon/settings.json`, query: stamp });
    this.docs.set(left.toString(), text);
    this.docs.set(right.toString(), result.text);
    await vscode.commands.executeCommand(
      'vscode.diff',
      left,
      right,
      `${tilde(file)} ↔ ${kind === 'setup' ? 'with' : 'without'} CC Beacon hooks`,
      { preview: true },
    );
    const action = kind === 'setup' ? 'Add Hooks' : 'Remove Hooks';
    const pick = await vscode.window.showInformationMessage(
      kind === 'setup' ? `Add CC Beacon's hooks to ${tilde(file)}?` : `Remove CC Beacon's hooks from ${tilde(file)}?`,
      {
        modal: true,
        detail:
          kind === 'setup'
            ? 'The diff shows the exact change. Your other settings and hooks stay as they are. A backup is written next to the file, and running Claude sessions pick up the change right away.'
            : "Only CC Beacon's entries are removed. A backup is written next to the file.",
      },
      action,
    );
    await closeDiff(right);
    this.docs.delete(left.toString());
    this.docs.delete(right.toString());
    if (pick !== action) return false;

    try {
      if (readSettings(file).text !== text) {
        void vscode.window.showWarningMessage(`${tilde(file)} changed while the preview was open. Nothing was written; run the command again.`);
        return false;
      }
      const { backup } = writeSettings(file, result.text);
      this.log(`${kind === 'setup' ? 'installed' : 'removed'} hooks in ${file}${backup ? ` (backup ${backup})` : ''}`);
      void vscode.window.showInformationMessage(
        `CC Beacon: hooks ${kind === 'setup' ? 'added to' : 'removed from'} ${tilde(file)}.${backup ? ` Backup: ${tilde(backup)}` : ''}`,
      );
    } catch (e) {
      void vscode.window.showErrorMessage(`CC Beacon couldn't write ${tilde(file)}: ${String(e)}`);
      return false;
    }
    if (kind === 'setup' && inspect(result.text, this.port()).disableAllHooks) this.warnDisabled();
    return true;
  }

  private warnDisabled(): void {
    if (this.warnedDisabled) return;
    this.warnedDisabled = true;
    void vscode.window.showWarningMessage(
      'Claude Code hooks are turned off ("disableAllHooks": true in ~/.claude/settings.json), so CC Beacon won\'t hear from Claude until that\'s removed.',
    );
  }
}

export function tilde(p: string): string {
  const home = os.homedir();
  return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

async function openFile(file: string): Promise<void> {
  try {
    await vscode.window.showTextDocument(vscode.Uri.file(file));
  } catch {
    // missing file: nothing to open
  }
}

async function closeDiff(modified: vscode.Uri): Promise<void> {
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      if (tab.input instanceof vscode.TabInputTextDiff && tab.input.modified.toString() === modified.toString()) {
        await vscode.window.tabGroups.close(tab);
      }
    }
  }
}
