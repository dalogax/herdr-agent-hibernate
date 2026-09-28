# herdr-opencode-hibernate

**Agent hibernation for Herdr**: auto-sleep idle agent panes (OpenCode,
Claude Code, Codex), resume the same session on focus.

Watches agent panes; when one has been `idle` past a window and is not
focused, submits the agent's exit command so the TUI exits cleanly back to
its shell (freeing the process and its RAM). The native session id is
recorded in the plugin state registry. When the pane is focused again, the
plugin relaunches the agent in that same pane with its native resume flags,
so the conversation picks up where it left off.

This exists because Herdr (as of 0.9.1) has no "free the process, keep the
pane" primitive — `pane release-agent` only clears an agent's registration,
it does not stop it. See herdrdev/herdr discussion #631.

## Supported agents

| Agent | Exit command | Resume flags | Requirements |
| --- | --- | --- | --- |
| OpenCode | `/exit` | `-s <id>` | `herdr integration install opencode` (lifecycle authority) |
| Claude Code | `/exit` | `--resume <id>` | `herdr integration install claude` (session identity) |
| Codex | `/quit` | `resume <id>` | `herdr integration install codex` (session identity) |

Lifecycle caveat: Claude and Codex states come from Herdr's screen manifest
detection (their integrations report only session identity), which can
occasionally misread state. The plugin re-checks immediately before sleeping
and never touches a working/blocked pane, so a misread degrades to a harmless
no-op rather than a lost session.

## Safety model

- sleeps only agents whose state is exactly `idle` or `done` — **never**
  `working`, `blocked`, or `unknown`, and never a focused pane
- rechecks the state immediately before sending the exit command
- the idle clock resets whenever the pane's agent leaves `idle` (any output,
  a new turn, a permission prompt)


Requires the OpenCode integration so Herdr has lifecycle state and the
native session id:

```sh
herdr integration install opencode
```

## Install

```sh
herdr plugin install dalogax/herdr-opencode-hibernate
```

Herdr clones the repo, previews the source and commands it will run, and
registers the plugin. Pin a revision if you prefer:

```sh
herdr plugin install dalogax/herdr-opencode-hibernate --ref <tag-or-commit>
```

For local development, link a checkout instead:

```sh
herdr plugin link /path/to/herdr-opencode-hibernate
herdr plugin list
herdr plugin action list --plugin dalogax.opencode-hibernate
```

**Cautious rollout:** `plugin install` and `plugin link` register the plugin
*enabled*, and enabling it spawns the idle watcher, which will start
sleeping your idle OpenCode panes after the window elapses. Verify scripted
sleep/resume once, then keep it enabled. To turn it off entirely:

```sh
herdr plugin disable dalogax.opencode-hibernate
```

## Actions

| Action | Meaning |
| --- | --- |
| `dalogax.opencode-hibernate.sleep-pane` | Sleep the context pane now (keybindable) |
| `dalogax.opencode-hibernate.resume` | Wake a specific sleeper |
| `dalogax.opencode-hibernate.list` | JSON dump of the sleeper registry |
| `dalogax.opencode-hibernate.ensure-watcher` | Start the watcher if the server predates plugin enablement |

CLI-equivalents (outside Herdr, for testing):

```sh
node bin/hibernate.js sleep-pane w1:p2
node bin/hibernate.js list
node bin/hibernate.js resume w1:p2
```


## Tuning

The idle window comes from the environment the watcher inherits. To change
it, set it before the Herdr server starts (or when re-spawning the watcher
with `ensure-watcher`):

```sh
export HIBERNATE_IDLE_MINUTES=30   # default 30
```
## Known limitations

- **Watcher is a best-effort daemon.** Plugin v1 startup hooks are one-shot,
  not supervised; the watcher is spawned detached from `startup`. If you stop
  the Herdr server, it dies with it and is re-spawned on next server start.
- **Resume takes the pane to a fresh TUI render.** The session (history,
  cwd, provider state) resumes, but on-screen scrollback is redrawn from the
  new TUI boot.
- **Resume flags**: `opencode -s <id>`, `claude --resume <id>`,
  `codex resume <id>` — the same argv Herdr's own native session restore
  uses, verified against its agent_resume planner. If a CLI changes its
  resume syntax, it's one line in `AGENT_PROFILES` in `bin/hibernate.js`.
- **Upstream coordination**: if Herdr ships a native "stop process, keep
  pane" method (the missing primitive named in discussion #631), this plugin
  should switch its sleep path to use it and delete the exit-command trick.
