# Connect Claude Code

CC Beacon hears from Claude Code through **hooks**: small commands Claude runs at moments like "needs your approval" or "finished". CC Beacon adds one entry per event to `~/.claude/settings.json`:

- Each entry runs `curl` to send the event to VS Code on `127.0.0.1`. Nothing leaves your machine.
- When VS Code is closed, the command does nothing and Claude shows no errors.
- Your other settings and hooks are not touched. You see the exact change first, and a backup is kept next to the file.
- Claude sessions that are already running pick up the hooks right away.

To undo it, run **CC Beacon: Remove Claude Code Hooks**. Uninstalling the extension removes them too.
