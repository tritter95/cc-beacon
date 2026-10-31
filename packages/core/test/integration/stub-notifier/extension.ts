// Stands in for CC Beacon Notifier in the integration test. It registers the same commands, reports
// that OS notifications are allowed, records every call, and posts nothing.
import * as vscode from 'vscode';
import {
  NOTIFIER_PROTOCOL,
  NotifierCommand,
  type Capabilities,
  type NotifyResult,
  type OkResult,
  type PermissionResult,
} from '../../../../shared/src/notifierApi';

export interface NotifierCall {
  command: string;
  arg: unknown;
  at: number;
}

export interface StubApi {
  calls: NotifierCall[];
}

export function activate(context: vscode.ExtensionContext): StubApi {
  const calls: NotifierCall[] = [];
  const handle = <T>(command: string, result: () => T) =>
    vscode.commands.registerCommand(command, (arg?: unknown) => {
      calls.push({ command, arg, at: Date.now() });
      return result();
    });

  context.subscriptions.push(
    handle<Capabilities>(NotifierCommand.capabilities, () => ({
      protocol: NOTIFIER_PROTOCOL,
      platform: process.platform,
      methods: ['helper'],
      permission: 'granted',
      alertStyle: 'banner',
      helperVersion: 'stub',
    })),
    handle<NotifyResult>(NotifierCommand.notify, () => ({ delivered: true, method: 'helper', ms: 0 })),
    handle<OkResult>(NotifierCommand.withdraw, () => ({ ok: true })),
    handle<OkResult>(NotifierCommand.playSound, () => ({ ok: true })),
    handle<PermissionResult>(NotifierCommand.requestPermission, () => ({ permission: 'granted' })),
    handle<void>(NotifierCommand.openSettings, () => undefined),
  );
  return { calls };
}
