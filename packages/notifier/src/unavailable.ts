// Delivery for platforms without OS notifications yet: Core falls back to in-window alerts.
import {
  NOTIFIER_PROTOCOL,
  type Capabilities,
  type NotifyResult,
  type OkResult,
  type PermissionResult,
} from '../../shared/src/notifierApi';
import type { NotifierPlatform } from './platform';

export class UnavailableNotifier implements NotifierPlatform {
  constructor(private readonly problem: string) {}

  async prepare(): Promise<void> {}

  async capabilities(): Promise<Capabilities> {
    return { protocol: NOTIFIER_PROTOCOL, platform: process.platform, methods: [], permission: 'unknown', problems: [this.problem] };
  }

  async notify(): Promise<NotifyResult> {
    return { delivered: false, ms: 0, error: this.problem };
  }

  async withdraw(): Promise<OkResult> {
    return { ok: true };
  }

  async playSound(): Promise<OkResult> {
    return { ok: false, error: this.problem };
  }

  async requestPermission(): Promise<PermissionResult> {
    return { permission: 'unknown' };
  }

  async openSettings(): Promise<OkResult> {
    return { ok: false, error: this.problem };
  }

  refresh(): void {}
}
