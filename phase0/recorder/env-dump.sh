#!/bin/sh
# Phase 0: command hook that records the hook's environment and stdin, to see what
# env vars Claude Code exposes to hooks (e.g. CLAUDE_CODE_ENTRYPOINT). Secrets are redacted.
out="${CCB_ENV_DUMP_DIR:-$(dirname "$0")/../fixtures/env}"
mkdir -p "$out"
ts=$(date +%Y%m%d-%H%M%S)-$$
cat > "$out/$ts.stdin.json"
env | sort | sed -E 's/^([^=]*(TOKEN|KEY|SECRET|PASSWORD|AUTH)[^=]*)=.*/\1=<redacted>/' > "$out/$ts.env.txt"
exit 0
