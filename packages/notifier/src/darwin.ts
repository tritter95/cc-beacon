// macOS delivery: CCBeaconNotifier.app (UNUserNotificationCenter), with osascript as the
// fallback only when the helper can't run. A denial is respected, never routed around (D10).
import fs from 'node:fs';
import path from 'node:path';
import type {
  Capabilities,
  NotifyRequest,
  NotifyResult,
  OkResult,
  PermissionResult,
  PlaySoundRequest,
  WithdrawRequest,
} from '../../shared/src/notifierApi';
import { describeFailure, run, type ExecResult } from './exec';
import { OSASCRIPT, postWithOsascript } from './fallback';
import {
  EXIT_NOT_AUTHORIZED,
  HELPER_BUNDLE_ID,
  HELPER_EXECUTABLE_RELATIVE,
  deriveCapabilities,
  notificationSettingsUrl,
  parseReply,
  postArgs,
  toPermission,
  withdrawArgs,
  type HelperProbe,
} from './helperCli';
import type { NotifierPlatform } from './platform';
import { playSystemSound } from './sound';

export interface DarwinOptions {
  /** Path to CCBeaconNotifier.app. */
  appPath: string;
  log: (message: string) => void;
  timeoutMs?: number;
  permissionTimeoutMs?: number;
  statusTtlMs?: number;
  /** Replaceable in tests so they don't post real notifications. */
  osascript?: (req: NotifyRequest) => Promise<OkResult>;
  openUrl?: (url: string) => Promise<OkResult>;
  now?: () => number;
}

export class DarwinNotifier implements NotifierPlatform {
  readonly helperPath: string;
  private probe?: { at: number; value: HelperProbe };
  private readonly timeoutMs: number;
  private readonly permissionTimeoutMs: number;
  private readonly statusTtlMs: number;
  private readonly osascript: (req: NotifyRequest) => Promise<OkResult>;
  private readonly openUrl: (url: string) => Promise<OkResult>;
  private readonly now: () => number;

  constructor(private readonly opts: DarwinOptions) {
    this.helperPath = path.join(opts.appPath, HELPER_EXECUTABLE_RELATIVE);
    this.timeoutMs = opts.timeoutMs ?? 3000;
    this.permissionTimeoutMs = opts.permissionTimeoutMs ?? 120_000;
    this.statusTtlMs = opts.statusTtlMs ?? 5 * 60_000;
    this.osascript = opts.osascript ?? ((req) => postWithOsascript(req));
    this.openUrl = opts.openUrl ?? (async (url) => {
      const r = await run('/usr/bin/open', [url], this.timeoutMs);
      return r.code === 0 ? { ok: true } : { ok: false, error: describeFailure(r) };
    });
    this.now = opts.now ?? Date.now;
  }

  /** Cheap insurance for friends' installs (ADR 0001 §7): exec bit and quarantine flag. */
  async prepare(): Promise<void> {
    const { appPath, log } = this.opts;
    let mode: number;
    try {
      mode = fs.statSync(this.helperPath).mode;
    } catch {
      log(`Notification helper missing at ${this.helperPath}; OS notifications will use osascript.`);
      return;
    }
    if ((mode & 0o111) !== 0o111) {
      try {
        fs.chmodSync(this.helperPath, 0o755);
        log(`Made the notification helper executable (mode was ${(mode & 0o777).toString(8)}).`);
      } catch (e) {
        log(`Couldn't make the notification helper executable: ${String(e)}`);
      }
    }
    const found = await run('/usr/bin/find', [appPath, '-xattrname', 'com.apple.quarantine'], this.timeoutMs);
    if (found.code === 0 && found.stdout.trim()) {
      const cleared = await run('/usr/bin/xattr', ['-dr', 'com.apple.quarantine', appPath], this.timeoutMs);
      log(cleared.code === 0
        ? 'Removed a quarantine flag from the notification helper.'
        : `Couldn't remove the helper's quarantine flag: ${describeFailure(cleared)}`);
    }
  }

  async capabilities(): Promise<Capabilities> {
    return deriveCapabilities(await this.status(), fs.existsSync(OSASCRIPT));
  }

  async notify(req: NotifyRequest): Promise<NotifyResult> {
    const started = this.now();
    const r = await this.helper(postArgs(req), this.timeoutMs);
    const reply = parseReply(r.stdout);
    const ms = () => this.now() - started;
    if (r.code === 0) return { delivered: true, method: 'helper', ms: ms() };
    if (r.timedOut) {
      // It may still post; falling back now could show the alert twice.
      this.opts.log(`notify ${req.id}: helper timed out after ${this.timeoutMs} ms`);
      return { delivered: false, ms: ms(), error: 'helper timed out' };
    }
    if (r.code === EXIT_NOT_AUTHORIZED && reply) {
      this.refresh();
      return { delivered: false, ms: ms(), error: reply.error ?? 'not authorized' };
    }
    const why = reply?.error ?? describeFailure(r);
    this.opts.log(`notify ${req.id}: helper failed (${why}); falling back to osascript`);
    this.refresh();
    const fb = await this.osascript(req);
    return fb.ok
      ? { delivered: true, method: 'osascript', ms: ms() }
      : { delivered: false, method: 'osascript', ms: ms(), error: `helper: ${why}; osascript: ${fb.error}` };
  }

  async withdraw(req: WithdrawRequest): Promise<OkResult> {
    const r = await this.helper(withdrawArgs(req), this.timeoutMs);
    const reply = parseReply(r.stdout);
    return reply?.ok ? { ok: true } : { ok: false, error: reply?.error ?? describeFailure(r) };
  }

  playSound(req: PlaySoundRequest): Promise<OkResult> {
    return playSystemSound(req);
  }

  async requestPermission(): Promise<PermissionResult> {
    const r = await this.helper(['request-permission'], this.permissionTimeoutMs);
    const reply = parseReply(r.stdout);
    this.refresh();
    if (!reply?.ok) {
      this.opts.log(`request-permission failed: ${reply?.error ?? describeFailure(r)}`);
      return { permission: 'unknown' };
    }
    return { permission: toPermission(reply.authorization) };
  }

  async openSettings(): Promise<OkResult> {
    const probe = await this.status();
    const bundleId = probe.kind === 'ok' && probe.bundleId ? probe.bundleId : HELPER_BUNDLE_ID;
    return this.openUrl(notificationSettingsUrl(bundleId));
  }

  refresh(): void {
    this.probe = undefined;
  }

  private async status(): Promise<HelperProbe> {
    if (this.probe && this.now() - this.probe.at < this.statusTtlMs) return this.probe.value;
    const r = await this.helper(['status'], this.timeoutMs);
    const reply = parseReply(r.stdout);
    const value: HelperProbe = reply?.ok && typeof reply.authorization === 'string'
      ? { kind: 'ok', authorization: reply.authorization, alertStyle: reply.alertStyle, bundleId: reply.bundleId, version: reply.version }
      : { kind: 'broken', error: reply?.error ?? describeFailure(r) };
    this.probe = { at: this.now(), value };
    return value;
  }

  private helper(args: string[], timeoutMs: number): Promise<ExecResult> {
    return run(this.helperPath, args, timeoutMs);
  }
}
