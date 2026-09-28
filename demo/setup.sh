#!/usr/bin/env bash
# Drives the demo recorded by demo.tape. Runs in the background while the
# tape starts `herdr --session hibdemo`, builds the layout, and focuses panes
# the way a user would. Talks ONLY to the hibdemo session's socket.
set -euo pipefail

SESSION=hibdemo
export HERDR_SOCKET_PATH="${HERDR_CONFIG_DIR:-$HOME/.config/herdr}/sessions/$SESSION/herdr.sock"
unset HERDR_PANE_ID HERDR_TAB_ID HERDR_WORKSPACE_ID
STATE="${XDG_STATE_HOME:-$HOME/.local/state}/herdr/plugins/dalogax.agent-hibernate/sessions/$SESSION"
PROJECT="${DEMO_PROJECT:-/tmp/my-app}"
h() { herdr "$@" 2>/dev/null; }

until h pane list >/dev/null; do sleep 0.2; done
sleep 1

agent=w1:p1
you=$(h pane split "$agent" --direction right --cwd "$PROJECT" --no-focus | jq -r .result.pane.pane_id)
logs=$(h pane split "$you" --direction down --cwd "$PROJECT" --no-focus | jq -r .result.pane.pane_id)
h pane rename "$agent" "agent" >/dev/null || true
h pane rename "$you" "you" >/dev/null || true
h pane rename "$logs" "hibernate log" >/dev/null || true

# Plugin log, trimmed to the interesting lines.
h pane run "$logs" "clear; tail -n0 -F '$STATE/watch.log' 2>/dev/null | sed -un -E 's/^[0-9-]+T([0-9:]+)\\.[0-9]+Z \\[[0-9]+\\] (slept|resumed) ([^ ]+) session=[^ ]+( via ([A-Z]+).*)?/\\1  \\2 \\3 \\5/p'" >/dev/null

h agent start demo --kind opencode --pane "$agent" --timeout 60000 >/dev/null
h agent prompt demo "Write a two-line poem about idle terminals. No preamble." --wait --timeout 120000 >/dev/null || true

# You move on to other work; the agent pane sits idle and unfocused.
h pane focus --pane "$agent" --direction right >/dev/null
h pane send-text "$you" "git status --short" >/dev/null

# Wait for the watcher to hibernate it...
until [ -s "$STATE/registry.json" ] && jq -e 'has("'"$agent"'")' "$STATE/registry.json" >/dev/null 2>&1; do sleep 0.5; done
sleep 4
# ...then come back to it.
h pane focus --pane "$you" --direction left >/dev/null
