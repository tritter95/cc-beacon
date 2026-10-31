# Phase 1 plan: MVP, macOS first

- **Date:** 2026-10-27
- **Status:** In progress on branch `phase1`. See [Progress](#progress-2026-10-27) below.
- **Inputs:** [PLAN.md](../PLAN.md) §4–§9, [ADR 0001](adr/0001-signal-transport.md), [`phase0/FINDINGS.md`](../phase0/FINDINGS.md), the fixtures in `phase0/fixtures/`.

This turns PLAN §9 Phase 1 into milestones you can build and check one at a time. Where Phase 0 or a closer look changed a detail of PLAN.md, the decision is recorded in §2 with the reason.

## Progress (2026-10-27)

| Milestone | State |
|---|---|
| M0 Scaffold | ✅ `npm run package` writes both VSIX files; `npm run install-local` is written but not yet run against your VS Code |
| M1 Pure logic | ✅ Normalizer, state machine, policy, presentation, paths; golden tests on the Phase 0 runs |
| M2 Hub, election, router | ✅ Including a real-socket failover test (new hub in < 1 s) and the security tests |
| M3 Hook installer | ✅ Code and golden tests. ⏳ Not yet run against your real `~/.claude/settings.json` (it needs your confirmation in the modal) |
| M4 Notifier and helper | ✅ |
| M5 Core in VS Code | ✅ Code done and smoke-tested in an isolated VS Code. ⏳ Manual checks with a real `claude` session, the panel and clicks |
| M6 Diagnose, test notification, walkthrough | ✅ Code done. ⏳ Fresh-profile walkthrough run |
| M7 fake-claude, integration smoke | ✅ `scripts/fake-claude.mjs`, and the `@vscode/test-cli` smoke test (`npm run test:integration`; `npm test` runs it after the unit tests). It runs in a downloaded VS Code stable with HOME, the profile and the port in a throwaway sandbox |
| M8 Exit verification | ⏳ Latency measured (below); manual checklist §6.2 pending |

**Isolated smoke test.** Both VSIX files were installed into a separate VS Code profile (`--user-data-dir`, `--extensions-dir`), so your normal setup was untouched. `fake-claude` POSTs went through the real hub, and these results came out of it:
- One hub and two spokes with 3 windows. Five concurrent sessions (3 by header, 2 by `cwd`) each alerted in exactly one window.
- Latency from hub receipt to helper post returned: **p50 116 ms, p95 173 ms, max 273 ms** (n = 20). Add ~17 ms for the hook itself.
- The exact installed hook command, run through `sh` with the token from `~/.cc-beacon/hook-header`, was accepted and routed by header. Against a dead port it exited 0 silently.

**Answers to §7 open questions:**
- #1, panel focus: `claude-vscode.primaryEditor.open(sessionId)` → `createPanel` reveals the session's open tab, or shows it in the sidebar if it's there. It only opens a new tab otherwise. This is from the Claude extension source; confirm with a click.
- #3, system sounds: `UNNotificationSound(named: "Glass")` plays `/System/Library/Sounds/Glass.aiff` (usernoted log). No sound files ship (D11 holds).
- #4, re-posting the same id: shows a new banner.
- #7, `-H @file`: works (D5 holds).

**Deviations found while building:**
- D2: a single root `package.json` instead of npm workspaces. The extension `package.json` files are manifests only, since esbuild bundles everything.
- §5.3: a window registers with `POST /cc-beacon/v1/windows/:id/stream` (body: window info; response: the SSE stream). The registration lasts exactly as long as the stream, so there is no `DELETE`. Updates still use `PUT`.
- M3: jsonc-parser 3.3.1 corrupts an array when removing its last element (`[1,2]` → `[12]`). Removals therefore replace or remove the whole event property, and every edit is checked against the intended object before anything is written.
- Build: jsonc-parser's UMD entry can't be bundled; esbuild uses its ESM entry (`mainFields`). The build now fails if a bundle contains an unresolved relative `require`.
- D7: "runs under VS Code" means under *any* instance of the VS Code app bundle, not this instance. That only matters when two VS Code instances run side by side, as in the smoke test.
- D15: `AskUserQuestion`'s `PostToolUse` adds `answers` and `annotations` to `tool_input`, so it never matched its `PermissionRequest`, and an answered question stayed "needs you" until `Stop`. Its key now covers only `questions`. The integration test found this.
- With `osNotifications.when` set to `notWatching` or `always`, an approval at L1 is still deferred for the 6 s grace period (§5.2). Revisit if that feels slow.

---

## 1. Scope

The Windows run hasn't happened yet, so Phase 1 is split in two.

| | **Phase 1a: macOS (now)** | **Phase 1b: Windows (after the Windows run)** |
|---|---|---|
| Core | Everything in PLAN §9 Phase 1, written OS-neutral | Windows hook form and installer form selection, Windows port offset |
| Notifier | Swift helper, `osascript` fallback, sounds | PowerShell 5.1 worker, toast XML, AUMID |
| Exit | Manual checklist on the Mac, p95 < 500 ms, no duplicates with 3 windows | The same checklist on the Windows machine |

Core's routing, path normalization and notifier interface already handle Windows in 1a, so 1b only adds the pieces listed in §9.

**Pulled forward from Phase 2** (cheap on macOS, and they keep Notification Center tidy):
- Withdraw a session's notifications when it is acknowledged. The helper already has `withdraw`.
- `idle_prompt` as a one-shot reminder. It is event-driven and needs no timers.

**Still Phase 2:** the Sessions view and Activity Bar badge, timer-based reminders (`reminder.*`), persistent toasts, taskbar flash, `New Claude Terminal`, and remote development.

---

## 2. Decisions made for Phase 1

| # | Decision | Why |
|---|---|---|
| D1 | `publisher: "todd"`. Extension IDs are `todd.cc-beacon` (Core) and `todd.cc-beacon-notifier`. Click URIs use the authority `todd.cc-beacon`. | PLAN §7. Changing the publisher later changes the URI authority and resets VS Code's URI consent, so it's chosen once. |
| D2 | npm workspaces: `packages/core`, `packages/notifier` and `packages/shared`. `shared` holds types and constants only; esbuild bundles it into both extensions, and it is never packaged on its own. | One source of truth for the notifier command API and the hub protocol. |
| D3 | `engines.vscode: ^1.93.0`, with `@types/vscode` pinned to `1.93.0` and `@types/node` at 20. | `vsce` refuses a `@types/vscode` newer than `engines`. 1.93 is the floor for shell execution events. |
| D4 | Port `48812 + uid % 100`, which is **48813** on this Mac. `ccBeacon.port` overrides it. | PLAN §4.1. |
| D5 | The token lives in `~/.cc-beacon/token` (mode 0600). It is created with `O_EXCL`, so two windows activating at once can't write different tokens. The hook reads it with `-H @"$HOME/.cc-beacon/hook-header"`, so `settings.json` holds no secret. If `-H @file` misbehaves (checked in M3), fall back to the ADR's inline header. | `~/.claude/settings.json` is often synced in a dotfiles repo. This also takes "token mismatch" out of the drift check. ADR 0001 §1 suggested trying it. |
| D6 | Router order: header → sticky binding → `CLAUDE_PID` ancestry → `cwd` → unmatched policy. | PLAN §4.2 puts the sticky binding first. But a session resumed (`claude --resume`) in another window should follow the header. |
| D7 | The `cwd` fallback is used only when `CLAUDE_PID`'s ancestry passes through VS Code, meaning an ancestor's executable lives inside the app bundle that contains `env.appRoot`. | Otherwise an iTerm session started in a workspace folder would be routed to that window. PLAN §1 lists those sessions as a non-goal. |
| D8 | The helper keeps Phase 0's `swiftc` + `lipo` build script (proven) rather than switching to SwiftPM. The bundle ID stays `local.ccbeacon.notifier`. | Permission is keyed to the bundle ID and is already granted on this Mac. |
| D9 | The helper's `post` **never prompts**. If authorization is `notDetermined`, it returns at once. Core then falls back to in-window alerts and offers "Turn on notifications". Only `request-permission` prompts, and only the walkthrough and the test notification call it. | In Phase 0, `post` blocked ~5.5 s on the first-run prompt. |
| D10 | `osascript` is used only when the helper can't run (missing, crashing, or failing its signature check). It is not used when the user **denied** CC Beacon notifications. | A denial is the user's choice. Getting around it through Script Editor would be hostile. |
| D11 | Each alert plays one sound. With an OS notification, the sound is the notification's own, so Focus/DND silences it. Otherwise `afplay` plays it. The sounds are macOS system sounds used by name, so nothing is shipped: `Glass` for needs-input, `Hero` for done, `Basso` for failed. If `UNNotificationSound(named:)` can't find system sounds (checked in M4), ship three original synthesized `.caf` files instead. | `afplay` ignores Focus/DND. System sounds avoid licensing questions. |
| D12 | Mute applies to the whole machine. It is stored in `globalState.mutedUntil` and read at alert time. If `globalState` doesn't reach other windows promptly (checked in M5), the hub broadcasts mute over SSE instead. | Alerts are decided in the window that owns the session, so every window needs the mute state. |
| D13 | The walkthrough has three steps: hooks, allow notifications plus a test notification, and the Persistent alert style. PLAN's step 4, "restart Claude sessions", is dropped. | Hooks hot-reload (Phase 0 row 3c). Terminals that predate the env var still route exactly through `CLAUDE_PID` ancestry. |
| D14 | `install-local` uninstalls the Phase 0 probe (`phase0.ccb-probe`, still installed) before installing Core. | The probe also sets `process.env.CC_BEACON_WINDOW` and would fight Core over panel routing. |
| D15 | A `PostToolUse` is ignored unless it matches the pending `PermissionRequest` on `tool_name` plus canonical-JSON `tool_input`, and its `prompt_id` is the current turn's. | `PostToolUse` is `async`, so it can arrive after `Stop` or after a parallel tool's `PermissionRequest`. `PermissionRequest` has no `tool_use_id`, but Phase 0's fixtures show its `tool_input` is identical to `PostToolUse`'s. |
| D16 | Workspace folders are passed through `realpath` before matching. Claude reports a realpath `cwd` (`/private/tmp/…`), while VS Code may hold `/tmp/…`. | Without it, `cwd` matching fails for anything under `/tmp` or `/var` on macOS. |

---

## 3. Repo layout after Phase 1a

```
cc-beacon/
├─ package.json            # workspaces; scripts: build, test, package, install-local, fake-claude, build:helper
├─ tsconfig.base.json
├─ vitest.config.ts
├─ .vscode/launch.json     # one Extension Development Host with both extensions
├─ packages/
│  ├─ shared/src/          notifierApi.ts  protocol.ts  hookEvents.ts
│  ├─ core/                # "cc-beacon", extensionKind ["workspace"]
│  │  ├─ src/extension.ts
│  │  ├─ src/hub/          server.ts  security.ts  election.ts  spokeClient.ts  token.ts
│  │  ├─ src/routing/      router.ts  pathNormalize.ts  windowIdentity.ts  processTree.ts  terminalTracker.ts
│  │  ├─ src/claude/       normalize.ts  hookConfig.ts  hookInstaller.ts  uninstall.ts
│  │  ├─ src/attention/    stateMachine.ts  policy.ts  context.ts  sessionStore.ts  mute.ts
│  │  ├─ src/ui/           statusBar.ts  toasts.ts  uriHandler.ts  sessionPicker.ts
│  │  ├─ src/diagnostics.ts
│  │  ├─ media/walkthrough/
│  │  └─ test/             unit/  integration/  fixtures/runs/*.jsonl
│  └─ notifier/            # "cc-beacon-notifier", extensionKind ["ui"]
│     ├─ src/              extension.ts  darwin.ts  fallback.ts  sound.ts  win32.ts (stub until 1b)
│     └─ native/darwin/    main.swift  Info.plist  build.sh  → build/CCBeaconNotifier.app
├─ scripts/                fake-claude.mjs  package.mjs  install-local.mjs
└─ dist/                   cc-beacon-core.vsix  cc-beacon-notifier.vsix   (gitignored)
```

Compared with PLAN §7, this adds `shared/`, `processTree.ts`, `context.ts`, `mute.ts`, `token.ts`, `uninstall.ts` and `sessionPicker.ts`. `phase0/` stays as a reference. A curated copy of its fixtures goes into `packages/core/test/fixtures/runs/`.

**Testability rule:** `hub/`, `routing/` (except `terminalTracker.ts`), `claude/` (except `hookInstaller.ts`) and `attention/` (except `context.ts` and `sessionStore.ts`) never import `vscode`, so Vitest runs them directly. The VS Code glue lives in `extension.ts`, `ui/`, `context.ts`, `sessionStore.ts`, `terminalTracker.ts` and `hookInstaller.ts`.

---

## 4. Milestones

They're in dependency order, and each one ends in something runnable. Sizes are rough working days. Each milestone lands as its own commit.

### M0. Scaffold and dev loop (0.5 d)

- Set up the root workspace, strict TypeScript, Vitest, and esbuild for each package (`cjs`, `platform: node`, `external: ['vscode']`).
- Both extensions:
  - activate on `onStartupFinished`
  - declare `capabilities.untrustedWorkspaces.supported: true` (ADR §9)
  - log to an output channel named "CC Beacon"
- `.vscode/launch.json` runs one Extension Development Host with both packages loaded.
- `npm run package` builds the helper (on macOS only), bundles both packages and writes `dist/*.vsix` (`vsce package --no-dependencies`).
- `npm run install-local` does three things:
  1. Uninstalls `phase0.ccb-probe` if it's present (D14).
  2. Installs Notifier, then Core, with `--force`.
  3. Prints "Reload VS Code windows".
- **Done when:** both VSIX files install, and *Developer: Show Running Extensions* lists both as activated.

### M1. Pure logic (2 d)

- `shared/hookEvents.ts`: loose types for the payload fields we read.
- `claude/normalize.ts`: raw payload plus headers → `BeaconEvent`, per PLAN §4.1. It never throws. Text rules are in §5.1.
- `attention/stateMachine.ts`: a reducer `(session, event, now) → { session, effects }`. The effects are `alert`, `withdraw`, `arm(timer)` and `disarm(timer)`. Timers are data that `sessionStore` runs, so tests can use a fake clock. The rules are in §5.2.
- `attention/policy.ts`: `(alert, level, settings, muted) → { statusBar, toast, os, sound }`, following the PLAN §4.4 matrix.
- `routing/pathNormalize.ts`: case folding (macOS and Windows), separators, trailing slashes, `/mnt/c` and `/c/`. The Windows cases are tested now and used in 1b.
- Fixtures:
  - Copy the Phase 0 `events.jsonl` runs into `test/fixtures/runs/`: `command-run`, `panel-run`, `interactive-run` and `vscode-terminal-run`.
  - Add synthetic payloads for `StopFailure`, `elicitation_dialog`, an unknown event and an unknown `notification_type`. None of these were recorded in Phase 0.
- **Done when:**
  - Replaying each fixture run through normalize and the state machine gives the expected states and alerts (golden files).
  - Every cell of the policy matrix has a test.

### M2. Hub, election and router (1.5 d)

- Files: `hub/token.ts`, `hub/security.ts`, `hub/server.ts`, `hub/election.ts`, `hub/spokeClient.ts`, `routing/router.ts`, `routing/processTree.ts`. The endpoints and rules are in §5.3.
- A hook POST gets its `204` before any processing, as Phase 0's recorder did.
- `processTree.ts` takes one `ps -A -o pid=,ppid=,comm=` snapshot, walks it in memory, and caches the result per `CLAUDE_PID`. It only runs when the header doesn't route the event.
- **Done when:**
  - Vitest starts 3 in-process "windows" on a random port, and events route by header, by ancestry and by `cwd`.
  - After the hub is killed, exactly one new hub appears within 1 s and every window re-registers.
  - The security tests pass: Origin, Host, content type, 1 MB limit and token.

### M3. Hook installer (1 d)

- `claude/hookConfig.ts` (pure):
  - Builds the expected entries (§5.3, hook entry).
  - `status(settingsText)` returns one of `ok | missing | partial | outdated | disabledAllHooks | parseError`.
  - Computes add and remove edits with `jsonc-parser`, using the file's own indentation.
  - Our entries are the ones whose `command` contains `/cc-beacon/v1/hook`.
- `claude/hookInstaller.ts` writes the file in this order:
  1. Show a diff preview (`vscode.diff` against a virtual document).
  2. Ask for confirmation in a modal.
  3. Write a backup, `settings.json.cc-beacon-<ts>.bak`, and keep only the newest 5.
  4. Write atomically: a temp file in the same directory, then rename, keeping the file mode.
  5. Before writing, resolve symlinks, so a dotfiles symlink isn't replaced by a plain file.
- It also writes `~/.cc-beacon/hook-header` (mode 0600) next to the token (D5).
- **Drift check:**
  - Runs only in the hub window, so you get one prompt per machine.
  - Runs at activation and when `ccBeacon.port` changes.
  - A missing `hook-header` file counts as `outdated`.
  - The prompt is non-modal: "Update hooks" or "Not now", which snoozes it for 7 days.
- `claude/uninstall.ts` is bundled to `dist/uninstall.js` and wired to `vscode:uninstall`. It shares `hookConfig`'s remove logic.
- **Check by hand:**
  - The `-H @file` header reaches the hub.
  - A running `claude` picks up newly installed hooks.
  - With VS Code quit, `claude` prints no hook errors.
- **Done when:** golden tests pass for:
  - a missing file and an empty file
  - existing user hooks
  - our own stale entries
  - a port change
  - invalid JSON (must refuse)
  - `disableAllHooks`
  - removing only our entries

### M4. Notifier and macOS helper (1.5 d)

- Move `phase0/mac-helper/` to `packages/notifier/native/darwin/` and change the helper to match §5.4:
  - `post` never prompts (D9).
  - Add `withdraw --thread` and `request-permission`.
  - `status` also reports the helper version.
  - The click log moves to `~/.cc-beacon/helper.log`, with a size cap.
- `build.sh`:
  - stamps `CFBundleShortVersionString` from `package.json`
  - takes an optional `BUNDLE_ID` override (used for testing in M6)
  - runs `codesign -s - --force` and then `codesign --verify`
  - is skipped on platforms other than macOS
- `notifier/src/darwin.ts`:
  - runs `execFile` per call (no daemon) with a 3 s timeout
  - `capabilities` caches `status` and refreshes it when the window gains focus
  - at activation, runs `chmod +x` and the quarantine check (ADR §7)
- `fallback.ts`: `osascript` with an `on run argv` script. Notification text is passed as arguments and never interpolated into the script (D10).
- `sound.ts`: `afplay -v <volume> /System/Library/Sounds/<Name>.aiff`.
- `win32.ts`: a stub that returns `methods: []` until 1b.
- **Checks:**
  - Does `UNNotificationSound(named: "Glass")` play (D11)?
  - Does re-posting the same id show the banner again? The `idle_prompt` reminder relies on it.
- **Done when:**
  - From a test command, `notify` shows a banner in under 300 ms.
  - A click opens the URI.
  - `withdraw --thread` clears a stack of notifications.
  - With the helper deleted, the `osascript` fallback posts.
  - With notifications turned off for CC Beacon, `capabilities().permission` is `denied`.

### M5. Core in VS Code (2 d)

- `routing/windowIdentity.ts`: `sha256(remoteAuthority + (workspaceFile || sorted folders))`, keeping the first 16 hex characters. Empty windows get a random id. Their older terminals still route through ancestry.
- Env injection:
  - `context.environmentVariableCollection.replace('CC_BEACON_WINDOW', id)`, persistent and with a description, for terminal sessions.
  - `process.env.CC_BEACON_WINDOW = id`, for panel sessions.
- `routing/terminalTracker.ts` tracks each terminal's shell PID (`processId`). It detects Claude commands from shell execution events and records when each terminal was last focused. Changes are sent to the hub.
- `attention/context.ts` computes L0–L3 (§5.2). It detects the Claude panel tab through `TabInputWebview.viewType` containing `claudeVSCodePanel`. With more than one Claude panel tab open, "watching" can't be known, so it's treated as L1, which leans toward alerting.
- `attention/sessionStore.ts`:
  - owns this window's sessions and runs their timers
  - sends each effect through the policy to the UI and the notifier
  - acknowledges a session after you've watched it for 1.5 s
  - alerts at once if the window loses focus while an alert is deferred
- UI files: `ui/statusBar.ts`, `ui/toasts.ts`, `ui/sessionPicker.ts`, `ui/uriHandler.ts` (§5.5) and `attention/mute.ts`.
- At activation, Core probes `ccBeacon.notifier.capabilities` with a 2 s timeout. If the Notifier is missing, Core uses in-window alerts only and shows one warning.
- **Checks:**
  - Does `claude-vscode.primaryEditor.open(sessionId)` focus the open tab, or open a second one?
  - What is the panel's exact `viewType` string?
  - When does `window.state.active` turn false (L3)?
  - Does `globalState` reach other windows promptly (D12)?
  - What is the panel `claude`'s parent PID?
- **Done when:** a real `claude` in a VS Code terminal and a real panel session each produce the right status bar, toast and OS notification for approve, deny, question and finish. A click must land on the right terminal or panel.

### M6. Diagnose, test notification, walkthrough (1 d)

- `diagnostics.ts` writes a Markdown report to an untitled document (§5.6). The recent events come from the hub (`GET /diagnostics`). Message text is redacted unless `ccBeacon.diagnostics.includeMessageText` is on (PLAN §6).
- **Send Test Notification:**
  1. If permission is `notDetermined`, explain first in a modal (ADR §6), then request it.
  2. Post a notification whose click URI is `…/test`.
  3. Clicking it shows "Click-through works". It also gets VS Code's one-time URI consent out of the way.
- **Open OS Notification Settings** opens the deep link `x-apple.systempreferences:com.apple.Notifications-Settings.extension?id=local.ccbeacon.notifier`.
- The walkthrough has three steps (D13) and opens once, on first activation.
- Status bar warnings, each with an action: port occupied, hooks missing, Notifier missing, notifications denied.
- **Testing first-run and denied flows:** permission is keyed to the bundle ID, so build a throwaway helper with `BUNDLE_ID=local.ccbeacon.notifier.test1 npm run build:helper`. That exercises the flows without touching the real helper's permission.
- **Done when:** a fresh profile (`code --user-data-dir <tmp> --extensions-dir <tmp>`) gets from install to a clicked test notification by following only the walkthrough.

### M7. fake-claude and integration smoke test (0.5–1 d)

- `scripts/fake-claude.mjs` (§5.7).
- An `@vscode/test-cli` smoke test:
  - A stub notifier extension records the calls it receives.
  - `ccBeacon.osNotifications.when` is `always`, so window focus doesn't matter.
  - It checks that Core activates, the hub listens, and one replayed run produces the expected status bar text and notify calls.
- **Done when:** `npm test` runs the unit and integration tests on this Mac.

### M8. Exit verification (1 d)

- Run the manual checklist (§6.2), the latency test (§6.3) and the duplicates test (§6.4).
- Check that activation takes under 50 ms in *Show Running Extensions*.
- Record the results in `docs/phase1-results.md`. Update PLAN.md and the ADR wherever a Phase 1 check changed something, as was done after Phase 0.

**Total: about 10–11 working days for 1a.**

---

## 5. Specs

### 5.1 Normalizer output

| Raw event | Title | Subtitle | Body |
|---|---|---|---|
| `PermissionRequest`, `AskUserQuestion` | Claude has a question | `<project>` | `questions[0].question`, plus " (+N more)" |
| `PermissionRequest`, any other tool | Claude needs approval | `<project> · <tool_name>` | `tool_input.description`, else the `file_path` basename, else `command`, else empty |
| `Notification` `elicitation_*` | Claude needs input | `<project>` | `message` |
| `Notification` `permission_prompt` | *(merges into the pending needs-input alert)* | | |
| `Stop` | "Claude finished after 4m 12s" (duration shown when known), or "Claude has a question" if the last message ends with `?` | `<project>` | `last_assistant_message`, whitespace collapsed, Markdown markers stripped |
| `StopFailure` | Claude stopped with an error | `<project>` | An `error` or `message` field if present. The shape wasn't recorded, so the normalizer stays tolerant. |
| `Notification` `idle_prompt` | Claude is waiting | `<project>` | `message` |

- `<project>` is the name of the workspace folder that matched the session's `cwd`, or else the `cwd`'s basename.
- All text is plain and capped at `preview.maxChars` (140).
- With `preview.includeMessage: false`, bodies are left out.

### 5.2 Session state and alert rules

Each session has:
- a **state**: `working`, `needs-input`, `done`, `failed` or `idle` (quiet, unknown)
- **attention**: an alert fired and hasn't been acknowledged
- **pending**: the `PermissionRequest` being waited on (tool name plus canonical input)
- **turn**: its `prompt_id` and start time

| Event | Transition | Alert |
|---|---|---|
| `UserPromptSubmit` | → working; a new turn starts | None. Acknowledges the session and withdraws its notifications. |
| `PermissionRequest` | → needs-input; set pending | L2/L3: now. L0/L1: deferred, and a 6.5 s timer is armed. |
| `Notification` `permission_prompt` | stays needs-input | If the alert is deferred, fire it now at the *current* level. If it already fired, drop this one (collapse). |
| 6.5 s timer, no `permission_prompt` | → idle; pending is kept | None. The prompt was answered: approved and still running, or denied. |
| Window loses focus while an alert is deferred | — | Fire now (L2). |
| `PostToolUse` that matches pending (D15) | → working; clear pending | None; withdraw. |
| Any other `PostToolUse` | no change | None. |
| `Notification` `elicitation_*` | → needs-input | Now, at every level. No 6 s follow-up exists for it. |
| `Stop` | → done | Completed. At L0/L1, only if the turn lasted at least `minTurnSeconds`. |
| `StopFailure` | → failed | Failed (high). |
| `Notification` `idle_prompt` | no change | If a done alert is still unacknowledged, one reminder (L1 toast, L2 OS notification) re-posted with the same id. |
| `SessionEnd` | session removed | Withdraw. |
| Acknowledged | attention cleared; state kept | Withdraw the session's notifications. |

A session is acknowledged when you click its notification, click **Show**, or watch its terminal or panel for 1.5 s after an alert has fired.

**Dedupe:** an alert fires only on a transition. A repeat of the same `(session, kind, reason)` within 10 s is dropped.

**Levels** (PLAN §4.4):

| Level | Condition |
|---|---|
| L0 | `focused && active && watching` this session |
| L1 | `focused && active`, but not watching this session |
| L2 | `!focused` |
| L3 | `focused && !active` |

"Watching" means something different per session type:
- **Terminal session:** `window.activeTerminal` is the session's bound terminal.
- **Panel session:** the active tab is the window's only Claude panel tab.

**Policy:** PLAN §4.4's matrix, with `osNotifications.when` and the per-event `alerts.*` toggles applied. When muted, only the status bar changes.

### 5.3 Hub protocol (version 1) and hook entry

| Endpoint | Caller | Behavior |
|---|---|---|
| `POST /cc-beacon/v1/hook` | curl hook | Answer `204` at once. Then normalize, route, and deliver: in-process for the hub's own window, over SSE otherwise. |
| `GET /cc-beacon/v1/health` | Spoke, during election | `{ app: "cc-beacon", protocol: 1, version, hubWindowId }` |
| `PUT /cc-beacon/v1/windows/:id` | Spoke | Register or update `{ windowId, protocol, extHostPid, folders, name, focused, active, lastFocusedAt, terminals: [{ shellPid, name }] }` |
| `GET /cc-beacon/v1/windows/:id/stream` | Spoke | SSE. `route` messages carry the `BeaconEvent` plus the matched terminal PID. A `: ping` comment goes out every 15 s. Closing the stream unregisters the window. |
| `DELETE /cc-beacon/v1/windows/:id` | Spoke, on deactivate | Unregister. |
| `GET /cc-beacon/v1/diagnostics` | Any window's Diagnose | Windows, bindings, last 50 events (redacted), rejection counts. |

**Every request is checked for:**
- a loopback peer
- a `Host` of `127.0.0.1:<port>` or `localhost:<port>`
- no `Origin` header
- the token, compared with `timingSafeEqual`
- for POST and PUT, an `application/json` body of at most 1 MB

**Election:**
1. Call `listen(port, '127.0.0.1')`. If it succeeds, this window is the hub.
2. On `EADDRINUSE`, call `GET /health` up to 3 times over ~600 ms, since a hub that's still starting may not answer yet.
3. What happens next depends on who holds the port:
   - CC Beacon with the same protocol: this window becomes a spoke.
   - CC Beacon with a different protocol: the spoke shows "Reload windows to finish updating CC Beacon".
   - Anything else: an error state, "Port <n> is used by another program", shown in the status bar and in Diagnose.
4. When a spoke's stream closes, it waits 0–250 ms of random jitter and runs the election again.

**Latency** is measured where the alert is delivered. Each window records `receivedAt` (stamped by the hub) → "notify returned" for its own alerts, and Diagnose shows that window's p50 and p95.

**Hook entry** (D5). It is the same for every user except the port:

```json
{
  "type": "command",
  "timeout": 5,
  "command": "curl -s -o /dev/null --noproxy '*' --connect-timeout 1 -m 2 -X POST -H 'Content-Type: application/json' -H @\"$HOME/.cc-beacon/hook-header\" -H \"X-CC-Beacon-Window: $CC_BEACON_WINDOW\" -H \"X-CC-Beacon-Entrypoint: $CLAUDE_CODE_ENTRYPOINT\" -H \"X-CC-Beacon-Claude-Pid: $CLAUDE_PID\" --data-binary @- http://127.0.0.1:48813/cc-beacon/v1/hook >/dev/null 2>&1; exit 0"
}
```

Events: `UserPromptSubmit`, `PermissionRequest`, `Notification`, `Stop`, `StopFailure` and `SessionEnd` are synchronous. `PostToolUse` uses `async: true` (ADR §2).

### 5.4 Notifier contract

The Notifier registers these commands and Core calls them. Arguments and results are JSON.

| Command | Request | Result |
|---|---|---|
| `ccBeacon.notifier.capabilities` | — | `{ protocol: 1, platform, methods: ('helper' \| 'osascript')[], permission: 'granted' \| 'denied' \| 'notDetermined' \| 'unknown', alertStyle?, helperVersion? }` |
| `ccBeacon.notifier.notify` | `{ id, threadId, title, subtitle?, body?, sound: string \| null, clickUri }` | `{ delivered, method, ms, error? }` |
| `ccBeacon.notifier.withdraw` | `{ id }` or `{ threadId }` | `{ ok }` |
| `ccBeacon.notifier.playSound` | `{ name, volume }` | `{ ok }` |
| `ccBeacon.notifier.requestPermission` | — | `{ permission }`, once the user answers |
| `ccBeacon.notifier.openSettings` | — | — |

- `threadId` is the session key, so notifications group per session and acknowledgment withdraws by thread.
- `id` is `<sessionKey>:<kind>`, so a reminder replaces its original notification.

**Helper CLI** (`ccbeacon-notifier`). Each verb prints one line of JSON on stdout.

| Invocation | Behavior |
|---|---|
| `post --id --thread --title [--subtitle] [--body] [--sound default\|none\|<name>] [--open <url>]` | Exits 0 when posted. Exits 3 when not authorized, with `notDetermined` or `denied` in `error`. Never prompts. |
| `withdraw --id <id>` or `withdraw --thread <thread>` | Removes the matching delivered notifications. |
| `status` | `{ authorization, alertStyle, bundleId, version }` |
| `request-permission` | `{ authorization }`, once the user has answered. |
| No arguments (macOS launched it after a click) | Opens `userInfo.url` with `NSWorkspace`, then exits. |

### 5.5 Click-to-focus

The click URI is `vscode://todd.cc-beacon/focus?s=<sessionKey>`, passed through `env.asExternalUri` so that it gains a `windowId`. The handler:

1. For a terminal session, runs `terminal.show(false)` on its bound terminal.
2. For a panel session, runs `claude-vscode.primaryEditor.open(sessionId)`, with `claude-vscode.focus` as the fallback. The M5 check decides between them.
3. For an unknown session (for example, after a window reload), shows the Show Sessions Quick Pick if the window has sessions. Otherwise it does nothing, since the window is already in front.
4. Acknowledges the session and withdraws its notifications.

The `/test` path shows "CC Beacon: click-through works".

### 5.6 Diagnose report

The report covers:
- VS Code and extension versions, and `claude --version` with a warning below 2.1.233
- the hub role, port, protocol and registered windows
- this window's id and env injection
- hook status from `hookConfig.status`, including `disableAllHooks` and any managed settings file at `/Library/Application Support/ClaudeCode/managed-settings.json` (`allowManagedHooksOnly`, `disableAllHooks`)
- the Notifier's methods, permission and alert style
- the last 20 events, redacted
- latency p50 and p95
- the fallbacks in use, and the count of rejected requests

It opens as an untitled Markdown document, ready to copy into a bug report.

### 5.7 fake-claude

`npm run fake-claude -- <run|scenario> [--window <id>] [--cwd <dir>] [--pid <n>] [--speed <x>] [--sessions <n>]`

- **Replay** replays a recorded run with its original relative timing (scaled by `--speed`). It rewrites the token, port, window header, `cwd` and `session_id`. Each replay gets a fresh `session_id`, so dedupe doesn't hide repeats.
- **Synthetic scenarios:**

  | Scenario | What it sends |
  |---|---|
  | `permission-approved` | `PermissionRequest`, then the matching `PostToolUse` |
  | `permission-denied` | `PermissionRequest`, then nothing |
  | `permission-ignored` | `PermissionRequest`, then `permission_prompt` 6 s later |
  | `question` | `PermissionRequest` for `AskUserQuestion` |
  | `long-turn` | `Stop` after more than `minTurnSeconds` |
  | `stop-failure` | `StopFailure` |
  | `elicitation` | `Notification` `elicitation_dialog` |
  | `idle-reminder` | `idle_prompt` while a done alert is unacknowledged |

- `--sessions 3 --windows a,b,c` runs concurrent sessions for the duplicates test.

---

## 6. Verification

### 6.1 Unit tests (Vitest)

| Module | Cases |
|---|---|
| `normalize` | Every fixture event. Unknown events and `notification_type`s. Missing fields. `AskUserQuestion` with several questions. Truncation. `includeMessage: false`. |
| `stateMachine` | **Permissions:** approve while watching and while away; deny while watching (timer → idle); deny while away (stays until ack or the next prompt); ignore while watching (the 6 s nudge); window blur while deferred. **Ordering:** a late async `PostToolUse` after `Stop`, and after a parallel tool's `PermissionRequest` (D15). **Turns:** `Stop` ending in `?`; `minTurnSeconds` gating; `StopFailure`. **Other:** `idle_prompt` reminds only while unacknowledged; `SessionEnd`; 10 s dedupe. |
| `policy` | Every matrix cell × `osNotifications.when` × mute × per-event toggles. |
| `router` | Header; sticky binding; header beats sticky; ancestry to a terminal shell PID; ancestry to an extension-host PID; `cwd` only with VS Code ancestry (D7); nested folders (longest prefix); ties broken by `lastFocusedAt`; unmatched `ignore` and `lastFocusedWindow`; `sdk-cli` ignored; re-routing after a window disappears. |
| `pathNormalize` | Case, separators, trailing slash, `/tmp` vs `/private/tmp` (D16), `/mnt/c`, `/c/`, UNC paths. |
| `hookConfig` | The M3 golden cases. |
| `security` | Each rejection rule. |
| `election` | The M2 failover test. |

### 6.2 Manual checklist (Mac)

**Setup:**
- Open test windows with `sh phase0/recorder/clean-env.sh code -n <dir>`, never plain `code -n` from inside a Claude session.
- Your Claude Code defaults to auto mode, which approves most Bash commands without a dialog. Use `AskUserQuestion` (or `claude --permission-mode default` in a terminal) to force a permission dialog.

| # | Scenario | Expected |
|---|---|---|
| 1 | CLI, new terminal, L0: approve within 6 s | Nothing beyond the status bar |
| 2 | CLI, L0: leave the prompt unanswered | After ~6 s: status bar pulse and a soft sound |
| 3 | CLI, L1 (another editor tab): question | After ~6 s: in-window toast with **Show**, plus a sound |
| 4 | CLI, L2 (another app): question | OS notification within 0.5 s; clicking it focuses the window and the terminal |
| 5 | CLI, L2: approval, then deny it in VS Code | The notification is withdrawn on acknowledgment; no stale badge |
| 6 | CLI, L2: long turn finishes | "Claude finished after …" OS notification |
| 7 | CLI, L0: short turn (< 20 s) finishes | Status bar only |
| 8 | CLI in a terminal opened *before* install (no env var) | Routes to the right window and terminal (ancestry) |
| 9 | Panel, L0 and L2: question and finish | As rows 2, 4 and 6; a click focuses the panel session without a duplicate tab |
| 10 | Minimized, another VS Code window focused, L3 idle, screen locked, Focus on | Each gets an OS notification (queued or silenced by the OS as it chooses); a click restores the right window |
| 11 | 3 windows, one session each, all L2 | One notification per session, each click lands in its own window |
| 12 | Close the hub window mid-session | A spoke takes over; the next alert arrives exactly once |
| 13 | Quit VS Code; use `claude` in iTerm | No hook error lines; no alerts |
| 14 | `claude` in iTerm inside a workspace folder, VS Code open | Ignored (D7) |
| 15 | Mute for 1 hour | Status bar only, in every window; unmute restores alerts |
| 16 | Remove hooks, then set them up again | Only our entries change; a backup is written; the diff preview is accurate |

### 6.3 Latency

1. Set `osNotifications.when: always`.
2. Run `fake-claude question` 50 times.
3. Read p95 of `receivedAt` → "notify returned" from Diagnose, and add the ~17 ms hook cost measured in Phase 0.

**Target:** under 500 ms. Also spot-check with a real `claude` by eye.

### 6.4 Duplicates

1. Open 3 windows.
2. Run `fake-claude --sessions 3` with one header per window. Add one session with no header (`cwd` routing) and one in a folder no window has open, which must be ignored.
3. Check `~/.cc-beacon/helper.log` and Diagnose: exactly one notification per expected alert.
4. Repeat while closing the hub window mid-run.

---

## 7. Open questions answered during Phase 1

| Question | Where | If the answer is bad |
|---|---|---|
| Does `claude-vscode.primaryEditor.open(sessionId)` focus the open tab or open a second one? | M5 | Use `claude-vscode.focus` when a Claude tab is already open |
| What is the Claude panel tab's `viewType`? Can the active tab's session be known? | M5 | Treat panel "watching" as L1 always |
| Does `UNNotificationSound(named:)` find system sounds? | M4 | Ship synthesized `.caf` files (D11) |
| Does re-posting the same id show the banner again? | M4 | Post reminders under a new id and withdraw the old one |
| Does `globalState` reach other windows promptly? | M5 | The hub broadcasts mute (D12) |
| When does `window.state.active` turn false (L3)? | M5 | Document it; L3 is treated like L2 anyway |
| Does curl's `-H @file` work in the hook? | M3 | Inline token, as in the ADR (D5) |
| What is the panel `claude`'s parent PID? | M5 | Nothing to change; the header routes panel sessions |
| What do `StopFailure` and elicitation payloads look like? | Opportunistic: the hub keeps raw payloads of rare and unknown events for Diagnose | The normalizer is tolerant |

---

## 8. Risks specific to Phase 1

| Risk | Mitigation |
|---|---|
| Async `PostToolUse` arrives out of order and clears the wrong needs-input | Match on tool and `prompt_id` (D15) |
| A denial emits nothing, leaving needs-input stale | The 6.5 s timer when watching; acknowledgment when away. A stale "waiting" can then only show in the tooltip, never as a badge. |
| `window.activeTerminal` stays set while the terminal panel is hidden, so L1 can look like L0 | Low impact: both levels defer needs-input, and L0 vs L1 only changes a toast into a status bar pulse. Documented as a known limitation (PLAN §4.4). |
| Two windows race on first activation | Token created with `O_EXCL` (D5); one election winner |
| Windows run mixed extension versions after an update | Protocol check, with a "Reload windows" prompt |
| Testing first-run permission flows would reset your real permission | Throwaway bundle ID for tests (M6) |

---

## 9. Phase 1b: Windows (after the Windows run)

Each item depends on an answer from the Windows run (ADR 0001, open item 1).

| Item | Depends on |
|---|---|
| Hook form per platform: the installer detects Git Bash and writes the curl form, or the `"shell": "powershell"` form. If the PowerShell form must be `async`, add a client timestamp header and order events by it. | The hook test: which forms are silent, and whether either blocks `PermissionRequest` |
| `notifier/src/win32.ts` and `native/win32/toast-worker.ps1`, grown from the probe's worker. AUMID from `product.json`, toast XML built in TypeScript, withdraw. | Toast identity and withdraw results |
| Worker start with `-File` under `RemoteSigned` | Mark-of-the-Web on files extracted from the VSIX |
| Click behavior: document foreground vs taskbar flash | The click test |
| Port offset from a hash of the username | — |

**Exit:** the same manual checklist passes on the Windows machine.
