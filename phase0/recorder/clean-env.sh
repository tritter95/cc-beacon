#!/bin/sh
# Phase 0: run a command with a minimal environment, so a Claude Code session started
# from inside another Claude Code session doesn't inherit CLAUDECODE / CLAUDE_CODE_* vars.
exec env -i \
  HOME="$HOME" USER="$USER" LOGNAME="$USER" SHELL=/bin/zsh \
  PATH="$HOME/.npm-global/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin" \
  TERM=xterm-256color LANG=en_US.UTF-8 TMPDIR="$TMPDIR" \
  ${CC_BEACON_WINDOW:+CC_BEACON_WINDOW="$CC_BEACON_WINDOW"} \
  "$@"
