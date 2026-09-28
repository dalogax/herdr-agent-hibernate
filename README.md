# herdr-opencode-hibernate

Orca-style **agent hibernation for Herdr**, scoped to OpenCode.

Watches OpenCode panes; when one has been `idle` past a window and is not
focused, submits `/exit` so the TUI exits cleanly back to its shell (freeing
the process and its RAM). The native session id is recorded in the plugin
state registry. When the pane is focused again, the plugin relaunches
OpenCode in that same pane with `--resume <session-id>`, so the conversation
picks up where it left off.

This exists because Herdr (as of 0.9.1) has no "free the process, keep the
pane" primitive — `pane release-agent` only clears an agent's registration,
it does not stop it. See herdrdev/herdr discussion #631 and the Orca
[Agent hibernation docs](https://www.onorca.dev/docs/agents/hibernation) for
the reference behavior. If you also run Orca, note it ships the desktop-app
equivalent of this plugin as an experimental built-in.

## Safety model (deliberately narrower than Orca)

- sleeps only agents whose state is exactly `idle` or `done` (Herdr's
  lifecycle authority from the OpenCode integration) — **never** `working`,
  `blocked`, or `unknown`, and never a focused pane
- rechecks the state immediately before sending `/exit`
- the idle clock resets whenever the pane's agent leaves `idle` (any output,
  a new turn, a permission prompt)
- no subagent/orchestration gating yet (Herdr has no orchestration concept,
  so Orca's "unsettled dispatch" check doesn't map; strict `idle`-only is the
  equivalent guard)

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
  new TUI boot. Orca has the same trade-off.
- **Resume flag**: uses `--session <id>`, which is Herdr's own documented
  resume mechanism for OpenCode panes (`opencode --session <id>`). If your
  OpenCode build prefers a different form, it's the one argv array in
  `resumePane()`.
- **Upstream coordination**: if Herdr ships a native "stop process, keep
  pane" method (the missing primitive named in discussion #631), this plugin
  should switch its sleep path to use it and delete the `/exit` trick.
