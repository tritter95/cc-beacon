import type {
  Capabilities,
  NotifyRequest,
  NotifyResult,
  OkResult,
  PermissionResult,
  PlaySoundRequest,
  WithdrawRequest,
} from '../../shared/src/notifierApi';

/** One OS's notification delivery. The extension forwards the notifier commands to it. */
export interface NotifierPlatform {
  /** One-time setup at activation (file permissions, quarantine). */
  prepare(): Promise<void>;
  capabilities(): Promise<Capabilities>;
  notify(req: NotifyRequest): Promise<NotifyResult>;
  withdraw(req: WithdrawRequest): Promise<OkResult>;
  playSound(req: PlaySoundRequest): Promise<OkResult>;
  requestPermission(): Promise<PermissionResult>;
  openSettings(): Promise<OkResult>;
  /** Forget cached permission state, e.g. when the user may have changed it in System Settings. */
  refresh(): void;
}
