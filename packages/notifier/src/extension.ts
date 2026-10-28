// CC Beacon Notifier: runs on the machine with your screen (extensionKind "ui") and delivers
// OS notifications and sounds for CC Beacon Core, which calls the commands registered here.
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  NotifierCommand,
  type NotifyResult,
  type OkResult,
} from '../../shared/src/notifierApi';
import { DarwinNotifier } from './darwin';
import { HELPER_APP_RELATIVE } from './helperCli';
import type { NotifierPlatform } from './platform';
import { isNotifyRequest, isPlaySoundRequest, isWithdrawRequest } from './requests';
import { UnavailableNotifier } from './unavailable';
import { createWin32Notifier } from './win32';

function createPlatform(context: vscode.ExtensionContext, log: (m: string) => void): NotifierPlatform {
  switch (process.platform) {
    case 'darwin':
      return new DarwinNotifier({ appPath: path.join(context.extensionPath, HELPER_APP_RELATIVE), log });
    case 'win32':
      return createWin32Notifier();
    default:
      return new UnavailableNotifier(`OS notifications aren't supported on ${process.platform} yet`);
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const out = vscode.window.createOutputChannel('CC Beacon Notifier');
  const log = (m: string) => out.appendLine(`${new Date().toISOString()} ${m}`);
  const platform = createPlatform(context, log);
  void platform.prepare().catch((e) => log(`prepare failed: ${String(e)}`));

  const invalid = (command: string): OkResult => {
    log(`${command}: ignored a malformed request`);
    return { ok: false, error: 'malformed request' };
  };

  context.subscriptions.push(
    out,
    // Permission may have just changed in System Settings; re-check when a window comes back.
    vscode.window.onDidChangeWindowState((s) => {
      if (s.focused) platform.refresh();
    }),
    vscode.commands.registerCommand(NotifierCommand.capabilities, () => platform.capabilities()),
    vscode.commands.registerCommand(NotifierCommand.notify, async (req: unknown): Promise<NotifyResult> => {
      if (!isNotifyRequest(req)) {
        invalid(NotifierCommand.notify);
        return { delivered: false, ms: 0, error: 'malformed request' };
      }
      const result = await platform.notify(req);
      log(`notify ${req.id}: ${result.delivered ? 'delivered' : 'not delivered'} via ${result.method ?? '-'} in ${result.ms} ms${result.error ? ` (${result.error})` : ''}`);
      return result;
    }),
    vscode.commands.registerCommand(NotifierCommand.withdraw, (req: unknown) =>
      isWithdrawRequest(req) ? platform.withdraw(req) : invalid(NotifierCommand.withdraw)),
    vscode.commands.registerCommand(NotifierCommand.playSound, (req: unknown) =>
      isPlaySoundRequest(req) ? platform.playSound(req) : invalid(NotifierCommand.playSound)),
    vscode.commands.registerCommand(NotifierCommand.requestPermission, async () => {
      const result = await platform.requestPermission();
      log(`requestPermission: ${result.permission}`);
      return result;
    }),
    vscode.commands.registerCommand(NotifierCommand.openSettings, () => platform.openSettings()),
  );
  log(`activated (${process.platform}, ${context.extension.packageJSON.version})`);
}

export function deactivate(): void {}
