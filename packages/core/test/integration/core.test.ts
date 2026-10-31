// Integration smoke test (phase1-plan M7). Core runs in a real VS Code next to a stub Notifier. A
// recorded Claude session is posted to the hub over HTTP the way the installed curl hook sends it,
// and the status bar and the Notifier calls are checked after each step.
// Run it with `npm run test:integration`: that builds everything and prepares the sandbox.
/// <reference types="mocha" />
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import * as vscode from 'vscode';
import { NotifierCommand, type NotifyRequest } from '../../../shared/src/notifierApi';
import { SUBSCRIPTIONS } from '../../src/claude/hookConfig';
import { HEADER } from '../../src/claude/normalize';
import type { CoreApi } from '../../src/extension';
import { PATHS, PROTOCOL_VERSION, type Health } from '../../src/hub/protocol';
import type { HubDiagnostics } from '../../src/hub/server';
import type { StubApi } from './stub-notifier/extension';

const CORE_ID = 'todd.cc-beacon';
const STUB_ID = 'todd.cc-beacon-test-notifier';
// This file runs bundled, from test/integration/dist/.
const RUNS = path.resolve(__dirname, '../../fixtures/runs');

type Body = Record<string, unknown> & { hook_event_name: string; notification_type?: string };

/** The events of a recorded run that the installed hooks subscribe to, moved to a fresh session in cwd. */
function recordedSession(run: string, cwd: string): { sessionId: string; events: Body[] } {
  const sessionId = `it-${randomUUID()}`;
  const subscribed = new Set(SUBSCRIPTIONS.map((s) => s.event));
  const events = fs
    .readFileSync(path.join(RUNS, `${run}.jsonl`), 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => (JSON.parse(l) as { body: Body }).body)
    .filter((b) => subscribed.has(b.hook_event_name))
    .map((b) => ({ ...b, session_id: sessionId, cwd }));
  return { sessionId, events };
}

function request(
  port: number,
  token: string,
  method: 'GET' | 'POST',
  urlPath: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; text: string }> {
  const data = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path: urlPath,
        agent: false,
        timeout: 2000,
        headers: {
          [HEADER.token]: token,
          ...(data !== undefined ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
          ...headers,
        },
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (text += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text }));
      },
    );
    req.on('timeout', () => req.destroy(new Error(`${method} ${urlPath} timed out`)));
    req.on('error', reject);
    req.end(data);
  });
}

/** Retries a check until it passes, for state that settles asynchronously. */
async function eventually<T>(check: () => T | Promise<T>, ms = 5000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    try {
      return await check();
    } catch (e) {
      if (Date.now() > deadline) throw e;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('CC Beacon Core in VS Code', () => {
  let core: CoreApi;
  let stub: StubApi;
  let port: number;
  let token: string;
  let windowId: string;
  let cwd: string;

  const get = async <T>(urlPath: string): Promise<T> => {
    const r = await request(port, token, 'GET', urlPath);
    assert.equal(r.status, 200, `GET ${urlPath}`);
    return JSON.parse(r.text) as T;
  };
  const hook = async (body: Body) => {
    const headers = { [HEADER.window]: windowId, [HEADER.entrypoint]: 'cli' };
    const r = await request(port, token, 'POST', PATHS.hook, body, headers);
    assert.equal(r.status, 204, `${body.hook_event_name} was refused`);
  };
  const notifies = () => stub.calls.filter((c) => c.command === NotifierCommand.notify).map((c) => c.arg as NotifyRequest);
  const withdrawals = () => stub.calls.filter((c) => c.command === NotifierCommand.withdraw).map((c) => c.arg);
  const statusBarShows = (text: string) => eventually(() => assert.equal(core.statusBarText(), text));

  before(async () => {
    // The runner points HOME at the sandbox, so the token and Claude settings used here are throwaway.
    const sandbox = process.env.CC_BEACON_IT_SANDBOX;
    assert.ok(sandbox && os.homedir().startsWith(sandbox), `HOME (${os.homedir()}) is not inside the test sandbox`);
    stub = await vscode.extensions.getExtension<StubApi>(STUB_ID)!.activate();
    core = await vscode.extensions.getExtension<CoreApi>(CORE_ID)!.activate();
    port = vscode.workspace.getConfiguration('ccBeacon').get<number>('port', 0);
    token = fs.readFileSync(path.join(os.homedir(), '.cc-beacon', 'token'), 'utf8').trim();
    windowId = process.env.CC_BEACON_WINDOW ?? '';
    cwd = fs.realpathSync(vscode.workspace.workspaceFolders![0].uri.fsPath);
  });

  it('activates, injects its window id and becomes the hub on the configured port', async () => {
    assert.match(windowId, /^[0-9a-f]{16}$/);
    const health = await eventually(() => get<Health>(PATHS.health));
    assert.deepEqual(
      { app: health.app, protocol: health.protocol, hubWindowId: health.hubWindowId },
      { app: 'cc-beacon', protocol: PROTOCOL_VERSION, hubWindowId: windowId },
    );
  });

  it('starts quiet: hooks set up, the Notifier found and notifications allowed', async () => {
    // Core probes the Notifier at activation. The status bar reads "$(bell)" before the probe too,
    // so wait for the probe and give its result a moment to render.
    await eventually(() => assert.ok(stub.calls.some((c) => c.command === NotifierCommand.capabilities)));
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(core.statusBarText(), '$(bell)');
  });

  it('replays a recorded terminal session: question, answer, finish, end', async () => {
    const { sessionId, events } = recordedSession('vscode-terminal-run', cwd);
    let next = 0;
    const sendThrough = async (name: string, type?: string) => {
      while (next < events.length) {
        const body = events[next++];
        await hook(body);
        if (body.hook_event_name === name && (!type || body.notification_type === type)) return;
      }
      throw new Error(`the run has no ${name} ${type ?? ''} left`);
    };
    const project = path.basename(cwd);

    // osNotifications.when is "always", so the question becomes an OS notification at any level:
    // at L2 on PermissionRequest, at L1 once permission_prompt confirms nobody answered.
    await sendThrough('Notification', 'permission_prompt');
    const [question] = await eventually(() => {
      assert.equal(notifies().length, 1);
      return notifies();
    });
    assert.deepEqual(
      { id: question.id, threadId: question.threadId, title: question.title, subtitle: question.subtitle, body: question.body },
      { id: `${sessionId}:needs-input`, threadId: sessionId, title: 'Claude has a question', subtitle: project, body: 'Red or blue?' },
    );
    // asExternalUri tags the click URI with this window, so a click comes back here.
    assert.ok(question.clickUri.startsWith(`${vscode.env.uriScheme}://${CORE_ID}/focus?s=${sessionId}`), question.clickUri);
    assert.match(question.clickUri, /[?&]windowId=\d+/);
    await statusBarShows('$(bell-dot) 1');

    // The answer: the matching PostToolUse withdraws the question.
    let seen = withdrawals().length;
    await sendThrough('PostToolUse');
    await eventually(() => assert.deepEqual(withdrawals().slice(seen), [{ threadId: sessionId }]));
    await statusBarShows('$(sync~spin)');

    // The finish. minTurnSeconds is 0 in the sandbox, so even this quick replay alerts.
    await sendThrough('Stop');
    const done = await eventually(() => {
      assert.equal(notifies().length, 2);
      return notifies()[1];
    });
    assert.deepEqual(
      { id: done.id, threadId: done.threadId, subtitle: done.subtitle, body: done.body, replaceThread: done.replaceThread },
      { id: `${sessionId}:completed`, threadId: sessionId, subtitle: project, body: 'done', replaceThread: true },
    );
    assert.match(done.title, /^Claude finished( after \d+s)?$/);
    await statusBarShows('$(check) 1');

    // The recording stops before SessionEnd, so send one, as fake-claude --end does.
    seen = withdrawals().length;
    await hook({ hook_event_name: 'SessionEnd', session_id: sessionId, cwd, reason: 'other' });
    await eventually(() => assert.deepEqual(withdrawals().slice(seen), [{ threadId: sessionId }]));
    await statusBarShows('$(bell)');
    assert.equal(notifies().length, 2);

    // Every event was routed to this window by the X-CC-Beacon-Window header.
    const diag = await get<HubDiagnostics>(PATHS.diagnostics);
    const routed = diag.recent.filter((e) => e.session === sessionId);
    assert.equal(routed.length, events.length + 1);
    assert.deepEqual(new Set(routed.map((e) => `${e.windowId} via ${e.via}`)), new Set([`${windowId} via header`]));
  });
});
