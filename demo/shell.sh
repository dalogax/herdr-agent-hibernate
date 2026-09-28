#!/usr/bin/env bash
# Neutral prompt for the recording: no rc files, no user/host in the prompt.
export PS1='\[\e[36m\]~/my-app\[\e[0m\] $ '
# Version-manager shims (mise, asdf) print banners or loop without their rc
# hooks; resolve the real agent binaries once and put them first.
[ -n "${DEMO_AGENT_PATH:-}" ] && export PATH="$DEMO_AGENT_PATH:$PATH"
cd "${DEMO_PROJECT:-/tmp/my-app}"
exec bash --norc --noprofile -i
