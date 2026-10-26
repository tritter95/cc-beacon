# CC Beacon: Implementation Plan

A VS Code extension that alerts you on **macOS and Windows** when a **Claude Code** session needs your input or has finished its task. It alerts you whether VS Code is focused, in the background behind another app, or minimized.

> **Scope (decided).** Claude Code only, run either as the `claude` CLI in the integrated terminal or in the Claude Code VS Code panel. This is a free tool for you and maybe a few friends: it is built locally, shared as VSIX files, and never published, with no code signing or notarization beyond what the toolchain does automatically. See §12.

---

## 0. TL;DR of the design

1. **Signal capture:** a synchronous Claude Code **`command` hook runs curl**, which POSTs every relevant lifecycle event to a loopback server inside VS Code and always exits 0. (Phase 0 ruled out `type: "http"` hooks: they print an error on every turn when VS Code is closed. See [ADR 0001](docs/adr/0001-signal-transport.md).) On Windows the hook uses Git Bash's curl, or a `"shell": "powershell"` form when Git Bash is absent. The extension installs the hooks into `~/.claude/settings.json` with one click: preview, backup, idempotent, removable.
2. **Routing:** one VS Code window per machine becomes the **hub** and owns the fixed port. The other windows are **spokes** and fail over automatically. Each event goes to exactly one window, matched by an injected env var, then by the parent process of `CLAUDE_PID` (the terminal's shell), then by `cwd` against workspace folders.
3. **Decision:** a per-session **attention state machine** (working → needs-input / done / failed). An **attention ladder** chooses how loud to be based on where you are: watching the session, elsewhere in VS Code, in another app or minimized, or idle.
4. **Delivery:** a separate **UI-side companion extension** sends real OS notifications. On macOS it uses a tiny Swift helper built locally (`UNUserNotificationCenter`). On Windows it uses a PowerShell 5.1 WinRT toast under VS Code's own AppUserModelID. It also handles sound and Windows taskbar flash. Being UI-side, it works in Remote-SSH, WSL and Dev Containers.
5. **Return path:** clicking the notification opens a `vscode://` URI produced by `env.asExternalUri`, which VS Code tags with a `windowId`. The **exact originating window** comes to the front and the extension reveals the right terminal or Claude panel.

---

## 1. Goals, non-goals, success criteria

### Goals
- Alert when Claude Code **needs input**: a permission prompt, an `AskUserQuestion` question, an MCP elicitation, or idle waiting.
- Alert when Claude Code **finishes a turn**, and when it **fails** (API error, `StopFailure`).
- Alert in every window state: focused and watching, focused elsewhere, behind another app, minimized, or another VS Code window focused.
- Clicking an alert brings the **right window** forward and focuses the **right session**.
- Zero external runtime dependencies for the user. No network access beyond loopback, and no telemetry.

### Non-goals
- Non-Claude signals: VS Code tasks, long terminal commands, debug sessions, Copilot Chat.
- Licensing, trial periods, accounts, payments or usage limits. It's free and fully functional for everyone who installs it.
- Marketplace or Open VSX publishing, Developer ID signing and notarization, and multi-user polish.
- Linux. The platform layer makes it a cheap later add (`notify-send`).
- Approving or denying permissions from the notification itself (see §11).
- Notifying for Claude Code sessions running entirely outside VS Code (iTerm, Desktop app). These are ignored by default and can be opted in.

### Success criteria
- p95 latency of **under 500 ms** from hook firing to a visible OS notification.
- No duplicate alerts across windows. Never more than one alert per state change per session.
- Never slows or alters Claude Code. Hooks always return an empty 2xx in under 10 ms, or fail fast and non-blocking when VS Code is closed.
- Activation cost under 50 ms and near-zero idle CPU.

---

## 2. Verified facts that shape the design

| Fact | Consequence |
|---|---|
| Claude Code supports `"type": "http"` hooks: POST JSON to `url`; `headers` support `$VAR` interpolation for vars listed in `allowedEnvVars`; `timeout` per hook. Non-2xx and connection failure are **non-blocking** by default. An empty 2xx body means success. ([hooks ref](https://code.claude.com/docs/en/hooks)) | **Phase 0: rejected.** A connection failure is non-blocking but prints a visible hook error on every turn. A `command` hook running curl with `; exit 0` is silent and costs ~17 ms. The port is still fixed (configurable), and window hints still travel as headers. See ADR 0001. |
| Since Claude Code 2.1.299, a `PermissionRequest`/`PreToolUse` hook that can't start on Windows **blocks the tool call**. | The Windows installer must pick a hook form whose shell exists (Git Bash or `"shell": "powershell"`), and Diagnose must confirm events arrive. |
| Hook events include `Notification` (matchers `permission_prompt`, `idle_prompt`, `elicitation_dialog`, `elicitation_url_dialog`, `agent_needs_input`, `agent_completed`, `auth_success`, …), `Stop` (has `last_assistant_message`), `StopFailure`, `PermissionRequest`, `UserPromptSubmit`, `PreToolUse`/`PostToolUse`, `SessionStart`/`SessionEnd`, `SubagentStop`. | These give rich enough signals for needs-input, done, failed and acknowledged states. |
| "Claude Code fires the same hook events wherever it runs: terminal, IDE extensions, Desktop app, cloud." | Covers both CLI-in-terminal and the Claude Code VS Code panel. |
| `async: true` exists for **command** hooks only. HTTP hooks are awaited. | The server must ACK immediately and process asynchronously. Use a short `timeout` (2–3 s). |
| `~/.claude/settings.json` is strict JSON. `disableAllHooks` exists. | Use `jsonc-parser` edits for minimal diffs and detect `disableAllHooks`. |
| VS Code has **no stable extension API** for OS notifications, dock bounce or taskbar flash (taskbar-flash request #196165 closed as not planned; `window.nativeHandle` is proposed-only). VS Code's own chat notifications use internal `FocusMode.Notify` and Electron `Notification`, which extensions can't reach. | We must ship our own native delivery per OS. |
| `window.state.focused` and `window.state.active` ("interacted with recently", stable since 1.89) plus `onDidChangeWindowState`. | Drives the attention ladder, including the "focused but idle, probably walked away" case. |
| `onDidStart/EndTerminalShellExecution` are stable since 1.93 (`commandLine`, `cwd`, `exitCode` on the end event). They need shell integration. | Lets us track which terminals run `claude`, and gives generic "long command finished" signals. |
| `environmentVariableCollection` is per window and applies to integrated terminals created in that window. It does **not** reach processes other extensions spawn. All extensions in a window share one extension-host process, though, and a `process.env` change there **does** reach the `claude` the Claude panel spawns (Phase 0). | Exact window routing for both: `environmentVariableCollection` for terminal sessions, `process.env` for panel sessions. `CLAUDE_PID` ancestry, then `cwd`, are fallbacks. |
| `env.asExternalUri(vscode://…)` appends `windowId=<n>` on desktop, and VS Code routes the URI to that window, which then focuses itself. The first use shows a one-time "Allow extension to open this URI?" prompt. | Click-to-focus lands on the exact window. Onboarding triggers the consent prompt early. |
| Commands are routed across extension hosts automatically, with JSON-serialized arguments. `extensionKind: ["ui"]` always runs locally. | Split into a **workspace** core and a **UI** notifier, so remote/WSL works. |
| Windows toasts need an AUMID backed by a Start Menu shortcut. VS Code's installer creates one (`win32AppUserModelId` in `product.json`, e.g. `Microsoft.VisualStudioCode`). `launch="vscode://…"` with protocol activation works. WinRT is loadable in **Windows PowerShell 5.1**, not PowerShell 7. | Toasts appear *as VS Code* with its icon, at no binary cost. Read the AUMID from `env.appRoot/product.json` at runtime so Insiders and forks work. |
| macOS: `osascript display notification` is attributed to Script Editor, has no click action and is flaky on macOS 26. `UNUserNotificationCenter` needs a real `.app` bundle. Ad-hoc signing suffices to post (terminal-notifier 3.x proves it), and the linker ad-hoc signs arm64 builds automatically. Locally built files carry no quarantine xattr, so Gatekeeper never checks them. No third party can bounce VS Code's dock icon. | Build a small Swift helper `.app` locally; the automatic ad-hoc signature is enough. Use `osascript` only as a last-resort fallback. No dock bounce on macOS. |
| On Windows, Claude Code's hook job object can kill PowerShell spawned *from a hook* before its toast shows. Foreground-lock can turn a window focus into a taskbar flash. | Spawn all notifiers from the VS Code extension host, never from the hook. |

---

## 3. Architecture

```
 ┌──────────────── Machine where Claude Code runs (local, or remote via SSH/WSL/container) ─────────────────┐
 │                                                                                                         │
 │  claude (terminal)   claude (VS Code panel)        curl hook POST  http://127.0.0.1:<port>/cc-beacon/v1/hook │
 │        │                    │                      headers: token, X-CC-Beacon-Window ($CC_BEACON_WINDOW)│
 │        └────────────┬───────┘                                                                           │
 │                     ▼                                                                                   │
 │   ┌────────────── Window A ext host ──────────────┐     ┌──────── Window B ext host ────────┐           │
 │   │ CC Beacon Core  (extensionKind: workspace)     │ SSE │ CC Beacon Core (spoke)           │           │
 │   │  • Hub HTTP server (owns fixed port)  ─────────┼────►│  • registers folders/focus       │           │
 │   │  • Router (window env hint → cwd → policy)     │◄────┼─ • receives routed events        │           │
 │   │  • Session tracker + attention state machine   │     │  • same pipeline as below        │           │
 │   │  • Attention policy (ladder)                   │     └──────────────────────────────────┘           │
 │   │  • Status bar / in-window toasts / sessions UI │                                                    │
 │   │  • URI handler (click → focus terminal/panel)  │                                                    │
 │   └───────────────────────┬────────────────────────┘                                                    │
 └───────────────────────────┼─────────────────────────────────────────────────────────────────────────────┘
                             │ vscode.commands.executeCommand('ccBeacon.notifier.*', payload)  (cross-host)
 ┌───────────────────────────▼──────────── Local machine (always) ─────────────────────────────────────────┐
 │  CC Beacon Notifier  (extensionKind: ui)                                                                │
 │   • macOS: CCBeaconNotifier.app (Swift, UNUserNotificationCenter) → fallback osascript                  │
 │   • Windows: persistent powershell.exe 5.1 worker → WinRT toast as VS Code AUMID; FlashWindowEx          │
 │   • Sound playback (afplay / SoundPlayer)                                                               │
 │   • Click → opens vscode://…?windowId=N → VS Code focuses Window A → Core's URI handler reveals session  │
 └─────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

Two extensions are built from one monorepo and installed from local VSIX files (`npm run install-local`). Core does **not** declare `extensionDependencies`, because VS Code would try to resolve a missing dependency from the Marketplace. Instead, Core probes `ccBeacon.notifier.capabilities` at startup. If the Notifier is missing, Core falls back to in-window alerts and shows a warning. In a local window both run in the same local extension host. In a remote window, Core runs remotely, next to Claude, and Notifier runs locally, next to your screen.

---

## 4. Components

### 4.1 Claude Code hook integration

**Hook configuration** written to `~/.claude/settings.json`. One URL serves all events, because the event name is in the payload (`hook_event_name`):

```jsonc
{
  "hooks": {
    "UserPromptSubmit":  [{ "hooks": [ BEACON ] }],
    "PermissionRequest": [{ "hooks": [ BEACON ] }],
    "Notification":      [{ "hooks": [ BEACON ] }],
    "PostToolUse":       [{ "hooks": [ BEACON_ASYNC ] }],   // only clears state
    "Stop":              [{ "hooks": [ BEACON ] }],
    "StopFailure":       [{ "hooks": [ BEACON ] }],
    "SessionEnd":        [{ "hooks": [ BEACON ] }]
  }
}
// BEACON (macOS, and Windows with Git Bash) =
{
  "type": "command",
  "timeout": 5,
  "command": "curl -s -o /dev/null --noproxy '*' --connect-timeout 1 -m 2 -X POST -H 'Content-Type: application/json' -H 'X-CC-Beacon-Token: <token>' -H \"X-CC-Beacon-Window: $CC_BEACON_WINDOW\" -H \"X-CC-Beacon-Entrypoint: $CLAUDE_CODE_ENTRYPOINT\" -H \"X-CC-Beacon-Claude-Pid: $CLAUDE_PID\" --data-binary @- http://127.0.0.1:48812/cc-beacon/v1/hook >/dev/null 2>&1; exit 0"
}
// BEACON_ASYNC = BEACON + "async": true
// Windows without Git Bash: a "shell": "powershell" equivalent (form and sync/async decided by the Phase 0 Windows run).
```

- `; exit 0` keeps a closed VS Code silent (curl exits 7 on a refused connection). `--noproxy '*'` keeps a corporate `HTTP_PROXY` away from the loopback POST.
- `CC_BEACON_WINDOW` is injected into every integrated terminal via `environmentVariableCollection`, giving exact routing for terminal sessions. Core also sets it on its extension host's `process.env`, which panel sessions spawned by the Claude extension inherit (verified in Phase 0). Each mechanism only reaches its own kind of session, so both are needed. Unset variables expand to `""`.
- `CLAUDE_PID` is the Claude process. Its parent is the terminal's shell (`Terminal.processId`), which gives exact terminal routing without the active-terminal heuristic.
- `CLAUDE_CODE_ENTRYPOINT` is `cli` (terminal), `claude-vscode` (panel) or `sdk-cli` (headless `-p`, ignored by default).
- Default port: `48812` (0xBEAC) plus a per-user offset (`uid % 100` on POSIX, hash of username on Windows). This avoids accidental collisions on shared hosts. It can be overridden with `ccBeacon.port`, and the installer rewrites the URL.

**Event normalization** maps raw payloads to one internal model:

```ts
type Kind = 'needs-input' | 'completed' | 'failed' | 'progress' | 'ended' | 'info';
interface BeaconEvent {
  sessionKey: string;            // claude session_id
  kind: Kind;
  reason: 'permission' | 'question' | 'elicitation' | 'idle' | 'turn-complete'
        | 'error' | 'turn-started' | 'resolved' | 'session-start' | 'session-end' | 'other';
  cwd?: string;
  title: string;                 // e.g. "Claude needs approval"
  detail?: string;               // message / last_assistant_message preview (truncated)
  windowHint?: string;           // X-CC-Beacon-Window
  entrypoint?: string;
  receivedAt: number;
  raw?: unknown;                 // truncated, kept only in the diagnostics ring buffer
}
```

| Claude hook | Condition | → kind / reason | Default alert |
|---|---|---|---|
| `PermissionRequest` | `tool_name == AskUserQuestion` | needs-input / question (body = the question) | **High** |
| `PermissionRequest` | any other tool | needs-input / permission (body = `tool_input.description`) | **High** |
| `Notification` | `permission_prompt` | needs-input / permission, "still unanswered after 6 s" | Alert trigger when watching (L0/L1); otherwise collapses into the `PermissionRequest` alert |
| `Notification` | `elicitation_dialog`, `elicitation_url_dialog` | needs-input / elicitation | **High** |
| `Notification` | `idle_prompt` (CLI only; the panel sends none) | needs-input / idle | Normal. Treated as a *reminder* if a `Stop` alert for this turn is still unacknowledged. |
| `Notification` | `agent_needs_input` / `agent_completed` | needs-input / completed (background agents) | Normal |
| `Stop` | — | completed / turn-complete. Becomes "Claude has a question" if `last_assistant_message` ends with `?` | Normal, gated by `minTurnSeconds` when you're watching |
| `StopFailure` | — | failed / error | **High** |
| `UserPromptSubmit` | — | progress / turn-started (acknowledges, starts turn timer) | none |
| `PostToolUse` | session currently in needs-input | progress / resolved | none (clears, withdraws OS notification) |
| `SessionEnd` | — | session-end | none |
| `Notification` | `auth_success`, `quota_*`, `plugin_notification`, unknown | info | none (logged) |
| `SubagentStop` (fires ~1 s after every `Stop`), `SessionStart`, others | — | ignored | — |

**`PermissionRequest` is the primary needs-input trigger** (Phase 0). It fires ~40 ms after `PreToolUse`, when the dialog appears. `Notification(permission_prompt)` only follows **6 s later**, and only if the prompt is still unanswered, which is too late for an away alert but a good "you didn't answer" signal while watching. **A denial (Esc/"No") emits no event at all**, so needs-input also clears on `Stop`, `UserPromptSubmit`, acknowledgment, or (watching case) no `permission_prompt` within ~6.5 s.

The normalizer must be **tolerant**: unknown events, types and fields map to `info` and are never thrown on. Claude Code's hook surface changes fast.

**Hook installer** (`CC Beacon: Set Up Claude Code Hooks`):
1. Locate `~/.claude/settings.json`. Remote windows use the remote home, because Core runs there. Create the file if missing.
2. Parse it. If parsing fails, **refuse** and open the file, never overwrite. Warn if `disableAllHooks: true`.
3. Compute edits with `jsonc-parser` (`modify` + `applyEdits`) to keep the diff minimal. Our entries are identified by the URL prefix `…/cc-beacon/v1/hook`. Existing user hooks are never touched.
4. Show a **diff preview** (`vscode.diff` against a virtual doc), then write a backup `settings.json.cc-beacon-<ts>.bak` and do an **atomic write** (temp + rename).
5. Already-running Claude sessions pick up the new hooks without a restart (verified in Phase 0).
6. On every activation, run a **drift check**: hooks missing, port changed or token mismatched. Show a non-modal prompt with an "Update hooks" button.
7. `CC Beacon: Remove Claude Code Hooks` deletes only our entries. The `vscode:uninstall` script removes them on uninstall, using the same marker-based removal.

**Windows hook form.** If Git Bash is present, use the curl form above. Otherwise use a `"shell": "powershell"` form that forwards stdin's raw bytes with `HttpWebRequest` (`Proxy = $null`, 2 s timeout) and exits 0. PowerShell's startup cost may force it to `async: true`, in which case ordering relies on a client timestamp header. Since Claude Code 2.1.299, a guard hook (`PermissionRequest`) whose shell can't start **blocks the tool call** on Windows, so the installer only writes a form whose shell exists. The Phase 0 Windows probe tests both forms side by side.

### 4.2 Hub server and multi-window routing

**Election (per machine, per user):**
1. On activation, Core tries `http.createServer().listen(port, '127.0.0.1')`.
2. **Success** → this window is the **hub**. **EADDRINUSE** → `GET /cc-beacon/v1/health`. If it's a CC Beacon hub with a compatible protocol version, become a **spoke**. Otherwise enter an error state ("port in use by another program"), shown in the status bar and in Diagnose.
3. A spoke registers with `PUT /cc-beacon/v1/windows/:id` (workspace folders, focus/active, lastFocusedAt, claude terminals) and opens a long-lived **SSE stream** `GET /cc-beacon/v1/windows/:id/stream` for routed events. It sends state updates on focus changes and terminal changes.
4. When the stream closes (hub window closed), wait a random 0–250 ms jitter and retry step 1. One spoke wins and the rest reconnect. Events that arrive during the ~ms failover are lost, which is acceptable because hooks fail non-blocking.
5. A protocol version handshake covers the case where some windows run an older extension version after an update. On mismatch, show "Reload windows to finish updating CC Beacon".

All of this uses only Node core `http`, with no `ws` dependency.

**Window identity:** `windowId = hash(remoteAuthority + workspaceFile || sorted workspaceFolders)`. Empty windows get a random UUID. It is stable across reloads, so `environmentVariableCollection` can be `persistent: true` and restored terminals still route correctly.

**Routing an event (in the hub):**
1. **Sticky binding:** if `sessionKey` is already bound to a live window, use it.
2. **Window hint:** if `X-CC-Beacon-Window` matches a registered window, use it (terminal sessions via `environmentVariableCollection`, panel sessions via `process.env`).
2b. **Process ancestry:** walk up from `X-CC-Beacon-Claude-Pid` (once per Claude process, cached). A parent that is a spoke's registered terminal shell PID or extension-host PID identifies the window and the exact terminal.
3. **cwd match:** longest-prefix match of the normalized `cwd` against all windows' workspace folders. Lowercase on Windows/macOS, normalize separators, and map WSL `/mnt/c/…` and Git-Bash `/c/…`. Break ties by most recently focused window.
4. **Unmatched:** apply the `ccBeacon.unmatchedSessions` policy: `ignore` (default; it's a Claude session outside VS Code) or `lastFocusedWindow`.
5. Bind `sessionKey` to the chosen window. If that window's spoke disappears, re-route on the next event.

**Session → terminal binding (inside the window), for click-to-focus and "watching" detection:**
- Track terminals running `claude` via `onDidStartTerminalShellExecution` (`/^\s*(npx\s+\S*claude\S*|claude)\b/`) and `onDidEndTerminalShellExecution`. Record terminal, cwd and start time.
- Bind to the terminal whose `processId` is the parent of `CLAUDE_PID` (verified in Phase 0). This is exact, even with several Claude terminals in the same folder.
- Fallback when the PID lookup fails: the unique tracked claude terminal whose cwd matches. If several are ambiguous, the click opens a Quick Pick.
- **Exact mode (Phase 2):** largely superseded by the `CLAUDE_PID` parent match. Keep the terminal profile and `CC Beacon: New Claude Terminal` only if the PID lookup proves unreliable on Windows.
- Panel sessions (`entrypoint == claude-vscode`) bind to their Claude Code panel session by `session_id`.

### 4.3 Session tracker and attention state machine

Per-session state, owned by the window the session is routed to:

```
            UserPromptSubmit                     PermissionRequest / Notification(elicitation)
   ┌──────────────────────────────┐            ┌───────────────────────────────────────────┐
   ▼                              │            │                                           ▼
[working] ───── Stop ─────────► [done] ──┐   [working] ──────────────────────────────► [needs-input]
   │                              │      │                                                 │
   │ StopFailure                  │      │ idle_prompt (unacked) → reminder                │ PostToolUse / Stop /
   ▼                              │      ▼                                                 │ UserPromptSubmit / ack
[failed] ── UserPromptSubmit ─────┘   (same state)                                         ▼
                                                                                        [working]/[done]
 Any state ── SessionEnd ──► removed        Any alerting state ── acknowledged ──► attention cleared (state kept)
```

- **Acknowledgment** clears the status bar badge and withdraws OS notifications for the session. It happens when you click a notification, submit a new prompt, or the window is focused **and** the session's terminal or panel is active for ≥1.5 s.
- **Dedupe:** an alert fires only on a state *transition*. A repeat of the same `(sessionKey, kind, reason)` within 10 s is dropped. `PermissionRequest` and the later `permission_prompt` for the same tool call collapse into one alert.
- **Turn timing:** `UserPromptSubmit → Stop` duration feeds `minTurnSeconds` gating and appears in the notification ("finished after 4m 12s").
- **Reminders:** if `needs-input` stays unacknowledged for `reminder.afterMinutes` (default 5), re-alert up to `reminder.maxCount` (default 2) times.

### 4.4 Attention policy (the "ladder")

Each alert is evaluated against the window's **context**:

| Context | How it's detected | Meaning |
|---|---|---|
| **L0 Watching** | window `focused && active` and the session's terminal/panel is the active one | You're looking at it |
| **L1 In VS Code, elsewhere** | window `focused && active`, but a different editor, terminal or panel is active | You're nearby |
| **L2 Away from window** | `!focused`: another app, minimized, or another VS Code window | You can't see it |
| **L3 Idle** | `focused && !active` (no recent interaction) | Probably walked away; treated like L2 |

**Default modality matrix.** It satisfies "alert whether looking at VS Code or minimized", with loudness adapted to context:

| Event | L0 Watching | L1 Elsewhere in VS Code | L2 / L3 Away or idle |
|---|---|---|---|
| needs-input | status bar pulse + soft sound | in-window toast w/ **Show** + sound + status bar | **OS notification** (persistent style) + sound + taskbar flash (Win) |
| completed | status bar + soft sound *if turn ≥ minTurnSeconds* | in-window toast + sound *if turn ≥ minTurnSeconds* | **OS notification** + sound |
| failed | status bar + sound | in-window toast + sound | **OS notification** + sound |
| reminder | — | in-window toast | OS notification |

- `ccBeacon.osNotifications.when`: `away` (default, L2/L3) | `notWatching` (L1–L3) | `always`.
- Mute and quiet controls: `CC Beacon: Mute for 1 hour`, plus a status-bar quick toggle. OS Focus/DND/Focus Assist are respected, since the OS handles them.
- Known limitation: VS Code doesn't expose whether the terminal *panel* is visible or focused. "Watching" is approximated by `activeTerminal` / active tab, plus focus and activity. Errors bias toward alerting.

### 4.5 Notifier extension (UI side)

**Command API** (JSON-serializable, invoked cross-host from Core):
- `ccBeacon.notifier.notify({ id, threadId, title, subtitle, body, severity, sound, clickUri, persistent })` → `{ delivered, method }`
- `ccBeacon.notifier.withdraw({ id | threadId })`
- `ccBeacon.notifier.playSound({ name, volume })`
- `ccBeacon.notifier.flash({ windowTitleHint })` (Windows, best effort)
- `ccBeacon.notifier.capabilities()` → `{ platform, methods, permission: 'granted'|'denied'|'notDetermined'|'unknown' }`

**macOS: `CCBeaconNotifier.app`** (Swift, about 200 LOC, shipped inside the VSIX):
- `LSUIElement=YES` (no Dock icon), bundle ID such as `local.ccbeacon.notifier`, display name "CC Beacon". It shows up under that name in System Settings › Notifications.
- CLI verbs: `post --id --thread --title --subtitle --body --sound --open <url> [--time-sensitive]`, `withdraw --id|--thread`, `status`, `request-permission`.
- Uses `UNUserNotificationCenter`: `threadIdentifier` = session, so notifications group per session. A same `id` replaces the earlier one. `userInfo.url` = click URI.
- On click, macOS relaunches the app if it has exited. The delegate receives the response, calls `NSWorkspace.shared.open(url)`, and exits.
- Bundled `.caf` sounds live in `Contents/Resources` for `UNNotificationSound(named:)`.
- Built locally as a universal binary (`swift build -c release --arch arm64 --arch x86_64`) as part of `npm run package`, then assembled into the `.app` bundle. Universal means friends on Intel Macs work too. Run `codesign -s - --force` after assembling the bundle so the bundle signature is valid. No Developer ID and no notarization.
- **Friends' Macs (verified in Phase 0):** a friend who downloads the VSIX gets a quarantine flag on the `.vsix` file itself, but the files VS Code extracts carry none. `vsce` keeps the exec bit and the ad-hoc signature stays valid, so the helper runs without a Gatekeeper prompt. As cheap insurance, the Notifier still runs `fs.chmod` and clears a quarantine flag at activation if one is ever found.
- **Permission survives rebuilds and upgrades (verified):** it is keyed to the bundle ID. A rebuilt helper at a new path stays authorized. Never change the bundle ID.
- **Permission flow:** `post` blocks while the first-run prompt is on screen, so never await it on a hot path. A denial is permanent (macOS never asks again), so onboarding explains before requesting. `status` lets Diagnose show "Notifications denied → Open System Settings" (`x-apple.systempreferences:com.apple.Notifications-Settings.extension?id=local.ccbeacon.notifier`).
- Onboarding tells the user to set CC Beacon's alert style to **Persistent**, so needs-input notifications stay on screen. Info.plist's `NSUserNotificationAlertStyle` is ignored.
- Fallback chain: helper → `osascript display notification` (no click-through) → in-window only. Each step is logged.
- In-window sound: `afplay -v <vol> <file>`.

**Windows: persistent PowerShell 5.1 worker**:
- `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe -NoLogo -NoProfile -NonInteractive -File toast-worker.ps1` is spawned lazily and kept alive. It uses **no** `-ExecutionPolicy Bypass`, `-EncodedCommand` or `Add-Type`, because EDR tools on corporate machines flag them. VSIX-extracted files should carry no Mark-of-the-Web, so `RemoteSigned` allows `-File` (pending the Phase 0 Windows run). It reads NDJSON commands on stdin and writes results on stdout. This avoids a 0.5–1 s PowerShell startup per toast.
- Toast XML is built in TypeScript with strict XML escaping. `launch="<clickUri>" activationType="protocol"`. `tag` = hashed id (≤64 chars), `group` = `cc-beacon`. `<audio>` per severity. `scenario="reminder"` plus a **Show** button for persistent needs-input toasts (`ccBeacon.windows.persistentToasts`, default on).
- AUMID is read from `env.appRoot/product.json` (`win32AppUserModelId`). If its Start Menu shortcut is missing (zip or portable install), fall back to the Windows PowerShell AUMID and note this in Diagnose.
- Withdraw: `ToastNotificationManager.History.Remove(tag, group, aumid)`.
- Taskbar flash: `FlashWindowEx(FLASHW_TRAY | FLASHW_TIMERNOFG)` via `Add-Type` P/Invoke on the HWND found by `EnumWindows`, filtered to the VS Code main PID and a title match on the workspace name. It is **off by default**, because `Add-Type` is EDR bait on corporate machines. When enabled it is best effort, and off when ambiguous.
- In-window sound: `System.Media.SoundPlayer` in the same worker.
- Hostile environments (AllSigned GPO, Constrained Language Mode or AppLocker blocking WinRT) are detected on the worker's first handshake, which then falls back to in-window alerts and explains why in Diagnose.

**Sounds:** a few short, original or CC0 sounds ship in `.wav` and `.caf`: `needs-input`, `done` and `error`, each also selectable as `none`. Volume is a setting.

### 4.6 Click-to-focus

1. Core builds `vscode.Uri.parse(\`${env.uriScheme}://${publisher}.cc-beacon/focus?s=${sessionKey}\`)` and passes it through `env.asExternalUri(...)`, which adds `windowId`. The result goes into the notification as `clickUri`.
2. Clicking it means the OS opens the URI. VS Code routes it to that window and focuses it, and Core's `UriHandler` runs.
3. The handler reveals the bound terminal (`terminal.show(false)`) or the Claude Code panel session: `claude-vscode.primaryEditor.open(sessionId)`, which is what the Claude extension's own `vscode://anthropic.claude-code/open?session=<id>` runs, with `claude-vscode.focus` as a fallback. Phase 1 checks whether that focuses an open tab or opens a second one. If the binding is ambiguous, it shows a Quick Pick of the window's Claude sessions.
4. It marks the session acknowledged and withdraws its other notifications.
5. The first click shows VS Code's "Allow CC Beacon to open this URI?" dialog. Onboarding's **Send test notification** step makes the user hit it once, with the "Don't ask again" checkbox. VS Code stores that choice in its application storage (`extensionUrlHandler.confirmedExtensions`), not in `settings.json`, and we never write it ourselves.
6. Verified on macOS in Phase 0: the URI reaches window N and focuses it when another VS Code window is focused, when VS Code is behind another app, and when it is hidden. VS Code restores minimized windows in the same code path. An unknown `windowId` falls back to the last active window.
7. Known Windows caveat: foreground-lock may turn the focus into a taskbar flash. This is measured by the Phase 0 Windows probe and documented.

### 4.7 In-window UI (Core)

- **Status bar item:** `$(bell-dot) 2` with a warning background when any session needs input, `$(check)` briefly after completion, and `$(sync~spin)` while working. The tooltip lists sessions (repo, state, elapsed). Clicking it opens a Quick Pick of sessions → focus. `accessibilityInformation` is set.
- **In-window toasts:** `showWarningMessage` for needs-input and `showInformationMessage` for done, with **Show** and **Mute 1h** actions. They are non-modal.
- **Sessions view (Phase 2):** a "Claude Sessions" tree in its own view container. A `TreeView.badge` count on the Activity Bar icon shows sessions awaiting attention. Each item shows its state icon, cwd, last message preview and turn duration.
- **Walkthrough** (`contributes.walkthroughs`) has four steps: install hooks, send a test notification (grants OS permission and URI consent), set the persistent alert style, and restart Claude sessions.

### 4.8 Remote development

| Scenario | Where Core runs | Where Notifier runs | Notes |
|---|---|---|---|
| Local window | local | local | Simplest path |
| Remote-SSH / Dev Container / Codespaces | remote | local | Hooks POST to the remote loopback. The hub is per remote host. Installer writes the **remote** `~/.claude/settings.json` |
| Remote-WSL | WSL | Windows | Main Windows scenario. Toast shows on Windows |
| Local window, `claude` run in a plain `wsl.exe` terminal | Windows | Windows | WSL2 NAT mode can't reach Windows loopback. Works with mirrored networking. Otherwise recommend Remote-WSL (Diagnose detects `/mnt/…` cwd and explains) |

Phase 0 verifies that `window.state` and `env.asExternalUri` behave correctly from the remote extension host.

**Installing for remote windows:** the Notifier VSIX is installed once locally. The Core VSIX must also be installed on each remote host (SSH host, WSL distro, container). The easiest way is to run `code --install-extension cc-beacon-core.vsix` from that remote window's integrated terminal, which installs into the remote VS Code server. `npm run install-local` prints this hint.

If you never use Remote-SSH, WSL or Dev Containers, Phase 2's remote work can be skipped entirely. Keep the two-extension split anyway: it costs little and keeps the platform code isolated.

---

## 5. Configuration and commands

### Settings (`ccBeacon.*`)
| Setting | Default | Purpose |
|---|---|---|
| `enabled` | `true` | Master switch |
| `port` | `48812 + per-user offset` | Hub port (installer updates hooks) |
| `alerts.needsInput` / `alerts.completed` / `alerts.failed` | `true` | Per-event enable |
| `osNotifications.when` | `away` | `away` \| `notWatching` \| `always` |
| `inWindowToasts` | `true` | L1 toasts |
| `completed.minTurnSeconds` | `20` | Suppress L0/L1 completion alerts for quick turns |
| `reminder.afterMinutes` / `reminder.maxCount` | `5` / `2` | Re-alert unacknowledged needs-input (0 = off) |
| `sound.enabled` / `sound.volume` | `true` / `0.6` | Sound control |
| `sound.needsInput` / `sound.completed` / `sound.failed` | bundled names | Per-event sound or `none` |
| `preview.includeMessage` / `preview.maxChars` | `true` / `140` | Show Claude's message text in notifications (turn off for screen-sharing) |
| `unmatchedSessions` | `ignore` | `ignore` \| `lastFocusedWindow` |
| `windows.persistentToasts` | `true` | Needs-input toasts stay until dismissed |
| `windows.flashTaskbar` | `false` | Best-effort taskbar flash (needs `Add-Type`, which corporate EDR may flag) |

### Commands
`CC Beacon: Set Up Claude Code Hooks` · `Remove Claude Code Hooks` · `Send Test Notification` · `Mute for 1 Hour` / `Unmute` · `Show Sessions` · `Diagnose` · `Open OS Notification Settings` · `New Claude Terminal` (Phase 2)

**Diagnose** produces a Markdown report covering:
- the role (hub or spoke), port and registered windows
- hooks present, drifted or disabled, and the `claude --version` if found
- notifier method, permission state and AUMID
- the last 20 events, redacted
- latency stats and the fallbacks in use

The report can be copied into a bug report.

### Activation
`onStartupFinished`, so the hub is listening before Claude fires. Cost is a single `listen()` and some disposables.

---

## 6. Security and privacy

- **Loopback only:** bind `127.0.0.1`. Reject requests that carry an `Origin` header, have a non-`application/json` body, or a `Host` other than `127.0.0.1:<port>`/`localhost:<port>`. These checks block browser CSRF and DNS rebinding.
- **Token:** a per-user random token lives in `~/.cc-beacon/token` (mode 0600) and is written into the hook's `X-CC-Beacon-Token` header. The hub drops events without it, which protects against co-tenant spoofing on shared machines. Hub/spoke IPC uses the same token.
- **Shared multi-user hosts** (only relevant for a shared Remote-SSH box): a co-tenant could squat the port and *receive* hook payloads, which include `last_assistant_message`. The per-user port offset and Diagnose's "foreign occupant" check are enough for personal use. A Unix-socket `command`-hook mode is listed under Future ideas if it's ever needed.
- **Untrusted content:** everything shown is treated as plain text, with XML-escaping on Windows and length caps. The request body is limited to 1 MB.
- **Settings edits:** consent, diff preview, backup, atomic write and marker-scoped removal. Never edit project or managed settings.
- **No telemetry, no outbound network.** Diagnostic logs redact message text unless the user opts in.

---

## 7. Tech stack and repo layout

- TypeScript (strict), esbuild bundling, Node core modules only, plus `jsonc-parser`. `engines.vscode: ^1.93.0`.
- Swift Package for the macOS helper; a PowerShell 5.1 script for Windows.
- Tests: Vitest for pure logic and `@vscode/test-cli` + `@vscode/test-electron` for integration.
- Packaging: `@vscode/vsce package` creates local VSIX files and nothing is published. The `publisher` field in `package.json` is just a local name (e.g. `todd`), which also forms the URI handler authority `todd.cc-beacon`.
- `npm run package` builds the Swift helper (macOS only), bundles both extensions and writes `dist/cc-beacon-core.vsix` and `dist/cc-beacon-notifier.vsix`.
- `npm run install-local` runs `code --install-extension` for both, Notifier first, and prints the remote-install hint.
- **Windows machine:** build on the Mac and copy the two VSIX files over. The Notifier VSIX already contains the macOS helper, which is ignored on Windows. Windows needs no native build, since its notifier is a PowerShell script. You can also clone and run `npm run package` on Windows, which skips the Swift step.
- `env.uriScheme` and the `product.json` AUMID mean VS Code Insiders works too, at no extra cost.

```
cc-beacon/
├─ packages/
│  ├─ core/                         # "cc-beacon" (extensionKind: workspace)
│  │  ├─ src/
│  │  │  ├─ extension.ts
│  │  │  ├─ hub/        server.ts election.ts spokeClient.ts protocol.ts security.ts
│  │  │  ├─ routing/    router.ts pathNormalize.ts windowIdentity.ts terminalTracker.ts
│  │  │  ├─ claude/     hookInstaller.ts hookConfig.ts normalize.ts
│  │  │  ├─ attention/  sessionStore.ts stateMachine.ts policy.ts reminders.ts
│  │  │  ├─ ui/         statusBar.ts toasts.ts sessionsView.ts uriHandler.ts walkthrough/
│  │  │  └─ diagnostics.ts
│  │  └─ test/          unit/ integration/ fixtures/ (recorded hook payloads)
│  └─ notifier/                     # "cc-beacon-notifier" (extensionKind: ui)
│     ├─ src/           extension.ts darwin.ts win32.ts fallback.ts sound.ts
│     ├─ native/darwin/ Package.swift Sources/… Info.plist  → CCBeaconNotifier.app
│     ├─ native/win32/  toast-worker.ps1
│     └─ media/sounds/
├─ scripts/
│  ├─ fake-claude.ts                # replays fixture payloads with real timing
│  ├─ build-helper.sh               # swift build → assemble CCBeaconNotifier.app → codesign -s -
│  └─ install-local.ts              # vsce package both + code --install-extension (notifier first)
├─ docs/                            # troubleshooting notes, ADRs (e.g. signal-transport decision)
└─ .github/workflows/ci.yml         # optional: unit + integration tests on macOS & Windows runners
```

---

## 8. Testing strategy

**Unit (Vitest)**, run locally and optionally in CI on macOS and Windows:
- Normalizer against recorded fixtures, including unknown events and fields.
- State machine transitions, dedupe, reminders and turn timing.
- Attention policy matrix: every context × event × setting combination.
- Router and path normalization: Windows drive-letter case, UNC, `/mnt/c`, `/c/`, symlinks, nested workspace folders, multi-root.
- Hook installer golden files: missing file, empty, existing user hooks, our stale entries, port change, invalid JSON (must refuse), `disableAllHooks`.
- Security filters: Origin, Host, content type, size, token.
- Election: N in-process "windows" on a random port. Kill the hub and assert a single new hub and no lost registrations.

**Integration** (`@vscode/test-cli`; macOS and Windows):
- Extension activates and binds.
- `fake-claude` POSTs a session lifecycle and the test asserts the status bar text, the toasts, and calls to a **stub notifier** extension.
- URI handler focuses the right terminal.

**Native smoke tests** (on each machine):
- The helper's `status` and `post` exit 0.
- The PowerShell worker handshake succeeds and its toast XML validates.

**Manual checklist after each meaningful change** (cannot be automated reliably):
- Your Mac (macOS 26) and your Windows machine
- × contexts {watching, other tab, other app, minimized, other VS Code window, screen locked, Focus/DND on}
- × sessions {CLI terminal, Claude panel, 3 windows open; plus Remote-WSL/SSH only if you use them}
- × actions {click notification, ignore → reminder, approve in VS Code → notification withdrawn}

---

## 9. Roadmap

### Phase 0: Verify assumptions (2–3 days)
Write small throwaway test scripts that confirm the riskiest assumptions before building the real extension. This is developer testing, not a product trial. This machine runs macOS 26, so Tahoe gets covered directly.
1. Record **real hook payloads** for every event in §4.1, from both CLI and panel sessions. Save them as fixtures and confirm the `Notification` fields (`message`, `notification_type`, title?).
2. Measure the **timing** of `PermissionRequest` vs `Notification(permission_prompt)` and the `idle_prompt` delay. Confirm `PreToolUse(AskUserQuestion)` fires before the question renders.
3. **HTTP hook with nothing listening:** does the CLI or panel show an error line per event? What's the latency? What's the minimum Claude Code version with `http` hooks plus `allowedEnvVars`? Do running sessions pick up newly installed hooks? **Go/no-go for HTTP vs the command-hook fallback.**
4. Is `CLAUDE_CODE_ENTRYPOINT` (or another env var) present in hooks to distinguish panel from CLI? Find the Claude Code VS Code extension's command IDs for revealing its panel (from its `package.json`).
5. Confirm **`asExternalUri` → `windowId` routing** from an OS notification click on both OSes, local and Remote-WSL/SSH. Does Windows foreground the window or only flash it?
6. Get a locally built, **ad-hoc-signed Swift helper** to post, click through and relaunch on macOS 26 when spawned from the VS Code extension host. Check the permission prompt flow, and whether a rebuild re-prompts for permission.
7. Show a **Windows toast** under VS Code's AUMID from a persistent PS 5.1 worker, with protocol activation, withdraw, `scenario="reminder"`, and a portable install.
8. Check that `window.state` from a remote workspace host reflects the local window, and measure cross-host command latency.
9. **Friend install path:** download the VSIX through a browser onto a second Mac, or a fresh user account, and install it. Confirm the helper runs without a Gatekeeper prompt (no quarantine flag on extracted files). Repeat on a Windows machine that never had a build environment.

**Exit:** an assumptions doc (`docs/adr/0001-signal-transport.md`), a fixture set, and a go/no-go on every row above.

**Status (2026-10-25):** done on macOS; see [ADR 0001](docs/adr/0001-signal-transport.md) and `phase0/FINDINGS.md`. Still open: the Windows run (`phase0/windows/check-environment.ps1`, then `phase0/windows-probe/ccb-win-probe.vsix`). Phase 1 can start on macOS; Windows notifier work waits for the Windows run.

### Phase 1: MVP, local (≈2 weeks)
- Core: hub, election and spokes, router, normalizer, state machine, attention ladder, status bar, in-window toasts, URI handler (terminal and panel), hook installer (preview, backup, drift check, remove), Diagnose, Mute.
- Notifier: macOS helper (locally built, ad-hoc), `osascript` fallback, Windows PS worker toasts, sounds.
- `npm run package` / `npm run install-local` scripts, and the walkthrough with the test notification.
- **Exit:** the manual checklist passes for local windows on your Mac and your Windows machine; latency under 500 ms p95; no duplicates with 3 windows.

### Phase 2: Polish, and remote if you use it (≈1–1.5 weeks)
- Sessions view and Activity Bar badge, reminders, notification withdrawal on acknowledgment, Windows taskbar flash, persistent toasts.
- Claude terminal profile and `New Claude Terminal` for exact terminal binding.
- *If needed:* Remote-SSH, WSL and Dev Container verification and fixes. Diagnose detects WSL-without-Remote.
- **Exit:** the full manual checklist passes.

There is no Phase 3: publishing, signing and generic sources are out of scope. Further work is in §11.

---

## 10. Risks and mitigations

| Risk | Likelihood / impact | Mitigation |
|---|---|---|
| Claude Code hook schema or behavior changes | High / Med | Tolerant normalizer, fixture tests, version detection in Diagnose, a quick-patch release path |
| HTTP hooks noisy or erroring when VS Code is closed | **Happened** (Phase 0) | Switched to a command hook + curl that always exits 0 (ADR 0001) |
| A hook that can't start blocks `PermissionRequest` on Windows (Claude Code ≥ 2.1.299) | Med / High | Installer writes only a form whose shell exists; Diagnose confirms events arrive; the Phase 0 Windows run tests both forms |
| macOS notification permission denied, or Focus mode on | Med / High | Helper `status` → onboarding and Diagnose guidance; status bar and sound still work; optional time-sensitive (entitlement permitting) |
| Ad-hoc helper blocked, or permission reset after a rebuild | Low / Med | Built locally, so no quarantine flag; stable bundle ID; `osascript` fallback; Diagnose shows permission state |
| Windows toasts suppressed (no AUMID, Focus Assist, CLM/GPO) | Med / High | AUMID fallback, worker handshake detection, in-window fallback, Diagnose |
| Click doesn't bring the window forward on Windows (foreground lock) | Med / Low | Accept the flash; the right window is still targeted; document it |
| Port conflict or multi-user host | Low / Med | Per-user port offset, health-check identity, token, Diagnose, socket mode |
| Wrong terminal or window chosen | Med / Low | Sticky binding, active-terminal-at-prompt heuristic, Quick Pick on ambiguity, exact terminal profile |
| Editing `~/.claude/settings.json` breaks the user's config | Low / High | Refuse on parse errors, minimal `jsonc-parser` edits, backup, atomic write, preview, marker-scoped removal |
| Alert fatigue | Med / Med | Attention ladder, `minTurnSeconds`, dedupe, mute, per-event toggles |

---

## 11. Future ideas

- **Phone push when away for more than N minutes** (ntfy / Pushover), opt-in.
- **Approve or deny from the notification** via the `PermissionRequest` hook's `decision` output. This needs a held HTTP response, a timeout, and a careful look at the risk of approving tool use from a toast.
- **Unix-socket hook mode** (an `async` command hook writing to `~/.cc-beacon/beacon.sock`) for shared remote hosts.
- Linux support via `notify-send`/libnotify. The architecture already isolates the platform layer.
- A "focus session" mode that silences everything except needs-input.

---

## 12. Decisions

| # | Question | Decision |
|---|---|---|
| 1 | Scope | **Claude Code only.** No tasks, terminal-command, debug or Copilot sources. |
| 2 | Apple Developer ID / notarization | **Not needed.** Free tool for you and a few friends, so the macOS helper is ad-hoc signed (universal binary for Intel friends). |
| 3 | Distribution | **No Marketplace or Open VSX.** VSIX files: `npm run install-local` for you; friends get the two `.vsix` files (e.g. from a GitHub release on this repo) plus a short install README. `publisher` is a local placeholder; the helper's bundle ID is something stable like `local.ccbeacon.notifier`. |
| 4 | Prior art | **Ignored.** Built independently, and duplication is fine. |
| 5 | Monetization | **None.** Free and fully functional. No licensing, trial, account or usage-limit logic anywhere. |
