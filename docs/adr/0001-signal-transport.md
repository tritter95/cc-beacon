# ADR 0001: Signal transport, routing and delivery

- **Status:** Accepted for macOS (complete). The Windows rows are pending one run on the Windows machine (see *Open items*).
- **Date:** 2026-10-25
- **Tested on:** macOS 26.6.2, VS Code 1.139.1, Claude Code 2.1.310 (CLI and VS Code extension), Swift 6.4.
- **Evidence:** `phase0/FINDINGS.md`, payload fixtures in `phase0/fixtures/`, probes in `phase0/`.

## Context

PLAN.md assumed `type: "http"` hooks, `Notification(permission_prompt)` as the needs-input trigger, `cwd` routing for panel sessions, and a PowerShell worker started with `-ExecutionPolicy Bypass`. Phase 0 tested those assumptions against real Claude Code, VS Code and macOS. Several did not hold.

## Decisions

### 1. Transport: a synchronous `command` hook running curl, not an HTTP hook

HTTP hooks print a visible `hook error … ECONNREFUSED` line on every turn whenever VS Code is closed. That rules them out. A command hook that runs curl and always exits 0 is silent when nothing is listening. It costs about 17 ms when the hub is up, keeps event order (for synchronous hooks), and running sessions pick up hook changes without a restart.

Hook entry for macOS, and for Windows when Git Bash is present (tested form; `<token>` and `<port>` are filled in by the installer):

```json
{
  "type": "command",
  "timeout": 5,
  "command": "curl -s -o /dev/null --noproxy '*' --connect-timeout 1 -m 2 -X POST -H 'Content-Type: application/json' -H 'X-CC-Beacon-Token: <token>' -H \"X-CC-Beacon-Window: $CC_BEACON_WINDOW\" -H \"X-CC-Beacon-Entrypoint: $CLAUDE_CODE_ENTRYPOINT\" -H \"X-CC-Beacon-Claude-Pid: $CLAUDE_PID\" --data-binary @- http://127.0.0.1:<port>/cc-beacon/v1/hook >/dev/null 2>&1; exit 0"
}
```

- `; exit 0` is required. curl exits 7 on a refused connection, and a non-zero exit would surface as a hook error.
- `--noproxy '*'` is required on corporate machines. Otherwise `HTTP_PROXY` sends the loopback POST through the proxy.
- `PostToolUse` gets `async: true`, since it only clears state.
- Phase 1 can try `-H @<file>` to keep the token out of `settings.json`. It hasn't been tested.

**Windows hook safety.** Since Claude Code 2.1.299, a `PermissionRequest` or `PreToolUse` hook that cannot start on Windows **blocks the tool call** instead of letting it through. A CC Beacon hook whose shell is missing would therefore break Claude Code for the user. Rules:

- The installer writes the bash/curl form only when Git Bash is detected. Otherwise it writes the `"shell": "powershell"` form.
- Diagnose confirms that hooks actually reach the hub, for example that the hub saw a `UserPromptSubmit`.
- The minimum Claude Code version on Windows is 2.1.310.

Which form to use, and whether the PowerShell form must be `async` (PowerShell startup cost), is decided by the pending Windows hook test.

### 2. Subscribed events

| Event | Mode | Use |
|---|---|---|
| `UserPromptSubmit` | sync | Turn started; acknowledges the session |
| `PermissionRequest` | sync | **The needs-input trigger.** `tool_name == "AskUserQuestion"` means a question (body = question text); anything else means an approval (body = `tool_input.description`) |
| `Notification` | sync | `permission_prompt` (6 s, only while still unanswered; CLI and panel), `idle_prompt` (60 s after `Stop`; CLI only), `elicitation_*` |
| `PostToolUse` | async | Clears needs-input |
| `Stop` | sync | Turn complete (`last_assistant_message`) |
| `StopFailure` | sync | Failed. Not observed in Phase 0; keep the normalizer tolerant |
| `SessionEnd` | sync | Removes the session |

Dropped:
- `PreToolUse(AskUserQuestion)`: `PermissionRequest` covers it.
- `SubagentStop`: it fires about 1 s after every `Stop`.
- `SessionStart`: not needed.

### 3. Needs-input timing and clearing

- `PermissionRequest` fires about 40 ms after `PreToolUse`, which is when the dialog appears.
- `Notification(permission_prompt)` follows **6.0 s** later, and only if the prompt is still unanswered.
- Away (L2/L3): alert on `PermissionRequest`. Watching (L0/L1): wait for the 6 s `permission_prompt`, which only arrives if you haven't answered.
- **A denial (Esc or "No") emits no event.** Clear needs-input on any of: `PostToolUse`, `Stop`, `UserPromptSubmit`, acknowledgment, or, in the watching case, no `permission_prompt` within ~6.5 s.
- In **auto mode**, a command the classifier approves emits no `PermissionRequest`. The event means a person really has to answer, which is exactly the trigger we want.
- `idle_prompt` arrives 60 s after `Stop` for CLI sessions, including in a VS Code terminal. **Panel sessions send none.** It is only a hint: reminders run on CC Beacon's own timer, so panel sessions get reminders too.

### 4. Routing an event to a window

In order:

1. **`X-CC-Beacon-Window` header.**
   - Terminal sessions get it through `environmentVariableCollection`.
   - Panel sessions get it because Core sets `process.env.CC_BEACON_WINDOW` in the extension host the Claude extension shares. The panel's `claude` inherits it (verified). `process.env` does not reach terminals, so both mechanisms are needed.
2. **`CLAUDE_PID` ancestry** (fallback if a terminal predates the env injection).
   - CLI: the parent of `CLAUDE_PID` is the terminal's shell, which equals `Terminal.processId` (verified).
   - Panel: not needed, since the header is exact.
3. **`cwd`**, longest-prefix match against workspace folders.

`CLAUDE_CODE_ENTRYPOINT` tells the session types apart:
- `cli`: the terminal.
- `claude-vscode`: the panel (verified).
- `sdk-cli`: headless `-p`, ignored by default.

### 5. Click-to-focus

- `env.asExternalUri` appends `windowId=N`, and VS Code routes the URI to window N and force-focuses it. This was verified on macOS in four cases, about 50–90 ms from the URI being opened to the handler running:
  - another VS Code window focused
  - VS Code behind another app
  - VS Code hidden
  - a real notification click
- **Minimized:** VS Code's `doFocusWindow` restores minimized windows (verified in source only).
- An unknown `windowId` falls back to the last active window.
- **URI consent:** the "Allow … to open this URI?" prompt appears once per extension. "Don't ask again" is stored in VS Code's application storage (`extensionUrlHandler.confirmedExtensions`), not in `settings.json`. Onboarding's test notification triggers it.
- **Terminal sessions:** `terminal.show(false)`.
- **Panel sessions:** run `claude-vscode.primaryEditor.open(sessionId)`, which is what the Claude extension's own `vscode://anthropic.claude-code/open?session=<id>` handler runs. Fall back to `claude-vscode.focus`. Whether this focuses an already-open session tab or opens a second one is checked in Phase 1.

### 6. macOS delivery

- The ad-hoc signed universal Swift helper (`LSUIElement`, bundle ID `local.ccbeacon.notifier`) posts when spawned from the extension host, in 100–230 ms. A click relaunches it, and it calls `NSWorkspace.open(url)`.
- **Permission is keyed to the bundle ID.** A rebuilt helper (new code hash) at a new path stayed `authorized`, so extension upgrades don't re-prompt. Never change the bundle ID.
- A **denial is permanent**: macOS never asks again. Onboarding explains first and then requests permission. Diagnose deep-links to `x-apple.systempreferences:com.apple.Notifications-Settings.extension?id=local.ccbeacon.notifier`.
- `post` blocks while the first-run prompt is on screen (5.5 s in the test). Never await it on a hot path.
- `NSUserNotificationAlertStyle=alert` in Info.plist is ignored (the style stays `banner`). Onboarding tells the user to pick "Persistent".

### 7. Friend install

- **macOS: works.** The test marked the VSIX as downloaded by Safari, and again by Chrome (quarantine xattr), then installed it with VS Code. The extracted files carry no quarantine flag. Both `vsce` 3.6.0 and plain `zip` keep the helper's exec bit, the signature stays valid, and the helper runs. No `xattr -d` step is needed. Keep the activation-time `chmod` and quarantine check anyway, since they're cheap insurance.
- **Windows:** *pending*. Does a VSIX received by mail or download leave Mark-of-the-Web on the extracted `.ps1`? If it does, `RemoteSigned` would block `-File`.

### 8. Windows delivery (corporate-safe)

- Start the worker with `powershell.exe -NoLogo -NoProfile -NonInteractive -File toast-worker.ps1`. Use **no** `-ExecutionPolicy Bypass`, no `-EncodedCommand` and no `Add-Type`, since all three look like malware to EDR tools. This replaces the Bypass flag in PLAN §4.5.
- Taskbar flash needs `Add-Type` P/Invoke, so it is off by default and documented as unsafe on corporate machines.
- Under `AllSigned` or Constrained Language Mode, fall back to in-window alerts and explain why in Diagnose.
- Toasts, AUMID, `scenario="reminder"`, withdraw and protocol activation are all *pending: Windows run*.

### 9. Workspace trust

Both extensions declare `capabilities.untrustedWorkspaces.supported: true`. Without it, Restricted Mode disables them in every new folder.

### 10. Supported Claude Code versions

| Version | Change we depend on |
|---|---|
| 2.0.45 | `PermissionRequest` hook |
| 2.1.47 | `last_assistant_message` on `Stop` |
| 2.1.233 | `Notification(permission_prompt)` fires in the VS Code panel |
| 2.1.288 | `idle_prompt` no longer fires while background agents run |
| 2.1.299–2.1.310 | Windows: failing guard hooks block; PowerShell-shell hooks run without Git for Windows |

Minimum: **2.1.233 on macOS, 2.1.310 on Windows.** Diagnose warns below these.

## Go/no-go

| # | Phase 0 check | Result |
|---|---|---|
| 1 | Real payloads | ✅ CLI (tmux and VS Code terminal), headless, panel |
| 2 | Timing | ✅ |
| 3 | Transport | ❌ HTTP hooks → ✅ command hook + curl (macOS). ⏳ Windows forms |
| 4 | Entrypoint, panel commands | ✅ |
| 5 | Click → window routing | ✅ macOS, all window states. ⏳ Windows foreground vs flash |
| 6 | Swift helper | ✅ including permission across rebuilds |
| 7 | Windows toast | ⏳ |
| 8 | Remote `window.state` | ⏭ Not needed: Windows sessions run natively, not in WSL |
| 9 | Friend install | ✅ macOS (simulated download). ⏳ Windows |

**Phase 1 can start on macOS now.** Windows notifier work waits for rows 3, 5, 7 and 9 on Windows.

## Consequences

PLAN.md is updated to match: §0, §2, §4.1, §4.2, §4.5 and §4.6.

## Open items

1. **Windows run.** Use `phase0/windows/check-environment.ps1`, then `phase0/windows-probe/ccb-win-probe.vsix`. It covers toast identity and AUMID, reminder and withdraw, click routing (foreground vs flash), Mark-of-the-Web on extracted files, and the bash/curl and PowerShell hook forms, including whether either blocks `PermissionRequest`.
