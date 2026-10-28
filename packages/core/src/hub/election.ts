// Hub election (PLAN §4.2): try to listen on the port; if another CC Beacon hub has it, become its
// spoke. When the hub goes away, wait a random jitter and try again, so exactly one spoke takes over.
import type { RoutedEvent, WindowInfo } from '../model';
import { Router, type RouterOptions } from '../routing/router';
import { PATHS, PROTOCOL_VERSION, type Health } from './protocol';
import { HubServer, type HubDiagnostics } from './server';
import { hubRequest, SpokeClient } from './spokeClient';

export type Role = 'starting' | 'hub' | 'spoke' | 'error' | 'stopped';

export interface CoordinatorOptions {
  port: number;
  token: string;
  version: string;
  windowId: string;
  getInfo: () => WindowInfo;
  routerOptions: RouterOptions;
  onEvent: (r: RoutedEvent) => void;
  onRole: (role: Role, detail?: string) => void;
  log: (msg: string) => void;
  includeMessageText?: () => boolean;
  timing?: Partial<Timing>;
}

interface Timing {
  healthTries: number;
  healthDelayMs: number;
  jitterMs: number;
  errorRetryMs: number;
}

const DEFAULT_TIMING: Timing = { healthTries: 3, healthDelayMs: 200, jitterMs: 250, errorRetryMs: 30_000 };

export class Coordinator {
  role: Role = 'starting';
  detail?: string;
  private hub?: HubServer;
  private spoke?: SpokeClient;
  private retry?: NodeJS.Timeout;
  private stopped = false;
  private electing?: Promise<void>;
  private readonly timing: Timing;

  constructor(private readonly opts: CoordinatorOptions) {
    this.timing = { ...DEFAULT_TIMING, ...opts.timing };
  }

  start(): Promise<void> {
    return this.elect();
  }

  /** The window's info changed (focus, folders, terminals). */
  update(): void {
    if (this.hub) this.hub.router.upsertWindow(this.opts.getInfo());
    else this.spoke?.update(this.opts.getInfo());
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.retry);
    this.spoke?.close();
    this.spoke = undefined;
    const hub = this.hub;
    this.hub = undefined;
    await hub?.close();
    this.setRole('stopped');
  }

  /** The hub's diagnostics, whether this window is the hub or a spoke. */
  async hubDiagnostics(): Promise<HubDiagnostics | undefined> {
    if (this.hub) return this.hub.diagnostics();
    if (this.role !== 'spoke') return undefined;
    const r = await hubRequest(this.opts.port, this.opts.token, 'GET', PATHS.diagnostics);
    return r.status === 200 ? (r.body as HubDiagnostics) : undefined;
  }

  private elect(): Promise<void> {
    this.electing ??= this.electOnce().finally(() => (this.electing = undefined));
    return this.electing;
  }

  private async electOnce(): Promise<void> {
    if (this.stopped) return;
    const { port, token, version, windowId, log } = this.opts;

    const router = new Router(this.opts.routerOptions);
    const hub = new HubServer({
      port,
      token,
      version,
      localWindowId: windowId,
      router,
      onLocalEvent: this.opts.onEvent,
      log,
      includeMessageText: this.opts.includeMessageText,
    });
    try {
      await hub.listen();
      if (this.stopped) return void (await hub.close());
      router.upsertWindow(this.opts.getInfo());
      this.hub = hub;
      this.setRole('hub');
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== 'EADDRINUSE') {
        this.setRole('error', `Can't listen on 127.0.0.1:${port}: ${(e as Error).message}`);
        return this.schedule(this.timing.errorRetryMs);
      }
    }

    const health = await this.probeHealth();
    if (this.stopped) return;
    if (!health) {
      this.setRole('error', `Port ${port} is used by another program`);
      return this.schedule(this.timing.errorRetryMs);
    }
    if (health.protocol !== PROTOCOL_VERSION) {
      this.setRole('error', 'Another VS Code window runs a different CC Beacon version. Reload windows to finish updating.');
      return this.schedule(this.timing.errorRetryMs);
    }

    const spoke = new SpokeClient({
      port,
      token,
      windowId,
      onEvent: this.opts.onEvent,
      log,
      onClose: (reason) => {
        if (this.spoke !== spoke) return;
        this.spoke = undefined;
        log(`lost the hub (${reason}); re-electing`);
        this.setRole('starting');
        this.schedule(Math.random() * this.timing.jitterMs);
      },
    });
    this.spoke = spoke;
    try {
      await spoke.connect(this.opts.getInfo());
      if (this.stopped) return spoke.close();
      this.setRole('spoke', health.hubWindowId);
    } catch (e) {
      if (this.spoke === spoke) this.spoke = undefined;
      log(`couldn't join the hub: ${(e as Error).message}`);
      this.schedule(Math.random() * this.timing.jitterMs);
    }
  }

  /** A hub that is just starting may not answer yet, so ask a few times. */
  private async probeHealth(): Promise<Health | undefined> {
    for (let i = 0; i < this.timing.healthTries; i++) {
      if (i > 0) await new Promise((r) => setTimeout(r, this.timing.healthDelayMs));
      const r = await hubRequest(this.opts.port, this.opts.token, 'GET', PATHS.health, undefined, 500);
      const h = r.body as Partial<Health> | undefined;
      if (r.status === 200 && h?.app === 'cc-beacon') return h as Health;
    }
    return undefined;
  }

  private schedule(ms: number): void {
    if (this.stopped) return;
    clearTimeout(this.retry);
    this.retry = setTimeout(() => void this.elect(), ms);
  }

  private setRole(role: Role, detail?: string): void {
    if (this.role === role && this.detail === detail) return;
    this.role = role;
    this.detail = detail;
    this.opts.onRole(role, detail);
  }
}
