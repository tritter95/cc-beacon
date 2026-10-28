// In-window notifications for when you're in VS Code but not looking at the session (L1).
import * as vscode from 'vscode';
import type { Presentation } from '../attention/present';
import type { AlertKind } from '../attention/stateMachine';

export async function showToast(kind: AlertKind, p: Presentation, onShow: () => void, onMute: () => void): Promise<void> {
  const message = `${p.title} · ${p.subtitle}${p.body ? `: ${p.body}` : ''}`;
  const show = kind === 'needs-input' || kind === 'failed' ? vscode.window.showWarningMessage : vscode.window.showInformationMessage;
  const pick = await show(message, 'Show', 'Mute 1 Hour');
  if (pick === 'Show') onShow();
  else if (pick === 'Mute 1 Hour') onMute();
}
