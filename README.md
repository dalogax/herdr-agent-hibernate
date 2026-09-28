# herdr-agent-hibernate

**Agent hibernation for [Herdr](https://herdr.dev)**: auto-sleep idle agent
panes (OpenCode, Claude Code, Codex), resume the same session on focus.

![An idle OpenCode pane is hibernated after the idle window and resumes the same conversation when focused](demo/demo.gif)

<sub>Demo sped up, with a 12-second idle window (default: 30 minutes).</sub>

Watches agent panes; when one has been `idle` past a window and is not
focused, it ends the agent process cleanly so the pane drops back to its
shell (freeing the process and its RAM). Once the agent is verified gone, the
native session id is recorded in the plugin state registry. When the pane is
focused again, the plugin relaunches the agent in that same pane with its
native resume flags, so the conversation picks up where it left off.

This exists because Herdr has no "free the process, keep the pane"
primitive — `pane release-agent` only clears an agent's registration, it
does not stop it. See herdrdev/herdr discussion #631.

## Supported agents

| Agent | How it is stopped | Resume flags | Requirements |
| --- | --- | --- | --- |
| OpenCode | `SIGTERM` to the agent process | `-s <id>` | `herdr integration install opencode` (lifecycle authority) |
| Claude Code | `SIGTERM` to the agent process | `--resume <id>` | `herdr integration install claude` (session identity) |
| Codex | `/quit` typed into the composer | `resume <id>` | `herdr integration install codex` (session identity) |

Live-tested on Herdr 0.9.0, installed as a plugin (startup hook, idle
watcher, focus hook, actions):

- **OpenCode** and **Claude Code** (2.1): full watcher sleep → focus wake →
  conversation recalled.
- **Codex** 0.140: full sleep/wake cycle with `/quit` (by the original
  author). On resume, Codex may re-show first-run dialogs (update notice,
  hook trust) before the session loads; the plugin treats that as a
  successful resume, since you are looking at the pane.

### Why a signal, not `/exit`

Typing an exit command goes through the composer, so any unsent draft
becomes `<draft>/exit` and is **submitted as a real prompt**. With
auto-approve modes, that can run tools. OpenCode and Claude Code both
handle `SIGTERM` gracefully: the session is already persisted, terminal
modes are restored, and the draft is discarded (never executed). Codex
leaves the terminal's keyboard protocol enabled on any signal, so it keeps
the typed `/quit`. **Caveat:** if you leave unsent text in a Codex composer,
it will be submitted when the pane is slept. Exclude Codex with
`HIBERNATE_AGENTS=opencode,claude` if that matters to you.

## Safety model

- sleeps only agents whose state is exactly `idle` or `done`, **never**
  `working`, `blocked`, or `unknown`, and the watcher never sleeps a focused
  pane
- rechecks the state immediately before stopping the agent
- the idle clock resets whenever the pane's agent changes state (any output,
  a new turn, a permission prompt), including changes that happen and settle
  between two polls
- a sleeper is recorded only after the agent has actually left the pane; if
  it does not exit within 15 s, nothing is recorded and the pane is left alone
- Claude and Codex states come from Herdr's screen detection, which can
  occasionally misread. The pre-sleep recheck means a misread degrades to a
  no-op.

## Requirements

- Herdr ≥ 0.9.0 on Linux or macOS
- Node.js ≥ 18 on `PATH` (no npm dependencies; the plugin uses only the
  Node standard library)
- The Herdr integration for each agent you want hibernated (below)

## Install

```sh
herdr integration install opencode   # and/or claude, codex
herdr plugin install dalogax/herdr-agent-hibernate
```

Herdr clones the repo, previews the source and commands it will run, and
registers the plugin. Pin a revision if you prefer:

```sh
herdr plugin install dalogax/herdr-agent-hibernate --ref <tag-or-commit>
```

For local development, link a checkout instead:

```sh
herdr plugin link /path/to/herdr-agent-hibernate
herdr plugin action list --plugin dalogax.agent-hibernate
```

**Cautious rollout:** `plugin install` and `plugin link` register the plugin
*enabled*. The watcher starts with the next Herdr server start (or run the
`ensure-watcher` action), and will start sleeping idle agent panes after the
window elapses. To turn it off entirely:

```sh
herdr plugin disable dalogax.agent-hibernate
```

## Actions

| Action | Meaning |
| --- | --- |
| `sleep-pane` | Sleep the focused pane now (keybindable; must be idle) |
| `resume` | Wake the sleeper in the focused pane |
| `resume-all` | Wake every sleeper |
| `list` | JSON dump of the sleeper registry |
| `ensure-watcher` | Start the watcher if the server predates plugin enablement; replaces a watcher running outdated plugin code |

Invoke with `herdr plugin action invoke <action> --plugin dalogax.agent-hibernate`.
CLI equivalents (for testing):

```sh
node bin/hibernate.js sleep-pane w1:p2
node bin/hibernate.js list
node bin/hibernate.js resume w1:p2
```

## Tuning

Read from the environment the watcher inherits, i.e. the Herdr server's
environment (set before the server starts, then run `ensure-watcher`):

| Variable | Default | Meaning |
| --- | --- | --- |
| `HIBERNATE_IDLE_MINUTES` | `30` | Idle time before an unfocused pane is slept |
| `HIBERNATE_AGENTS` | `opencode,claude,codex` | Agent kinds the plugin may sleep |
| `HIBERNATE_POLL_SECONDS` | `60` | Watcher poll interval |
| `HIBERNATE_EXIT_TIMEOUT_SECONDS` | `15` | How long to wait for an agent to exit |
| `HIBERNATE_DEBUG` | unset | Log raw focus-event payloads |

## State and logs

`$HERDR_PLUGIN_STATE_DIR` (usually
`~/.local/state/herdr/plugins/dalogax.agent-hibernate/`) holds
`registry.json`, `watcher.pid` and `watch.log`. The log records state
changes, sleeps and resumes, and rotates at 1 MB. Herdr's plugin state dir
is shared by all Herdr sessions, but pane ids are per session, so named
sessions (`herdr --session work`) get their own `sessions/<name>/`
subdirectory, each with its own registry and watcher.

The watcher prunes registry entries for panes that were closed, and follows
panes that were moved (they get a new pane id but keep their terminal).

## What it runs on your machine

Herdr plugins run as your user without a sandbox, so here is the full list:

- a detached watcher process (`node bin/hibernate.js watch-loop`) that polls
  `herdr agent list` every minute
- `SIGTERM` sent to an idle OpenCode or Claude Code process in a pane; for
  Codex, `/quit` typed into its composer
- `herdr agent start … -- <resume flags>` in the same pane when you focus it
- `ps` to confirm the process named in `watcher.pid` is really the watcher

It makes no network requests and reads nothing outside Herdr's CLI output
and its own state directory.

## Development

```sh
npm test
```

The tests drive `bin/hibernate.js` against a fake `herdr` CLI
(`test/fake-herdr.js`, selected via `HERDR_BIN_PATH`), so they need no
running Herdr server. The demo GIF is reproducible; see
[demo/README.md](demo/README.md).

## Known limitations

- **Watcher is a best-effort daemon.** Plugin v1 startup hooks are one-shot,
  not supervised; the watcher is spawned detached from `startup`. Only one
  runs per Herdr session; it exits on its own if the server is unreachable
  for 10 polls, and the next server start spawns a fresh one.
- **Resume takes the pane to a fresh TUI render.** The session (history,
  cwd, provider state) resumes, but on-screen scrollback is redrawn from the
  new TUI boot.
- **Resume flags**: `opencode -s <id>`, `claude --resume <id>`,
  `codex resume <id>`, the same argv Herdr's own native session restore
  uses. If a CLI changes its syntax, it's one line in `AGENT_PROFILES` in
  `bin/hibernate.js`.
- **A session id is needed before sleeping.** An agent that has not been
  sent a message yet has no session, so it is never slept.
- **Upstream coordination**: if Herdr ships a native "stop process, keep
  pane" method (the missing primitive named in discussion #631), this plugin
  should switch its sleep path to use it.

## License

[MIT](LICENSE). Not affiliated with or endorsed by the Herdr, OpenCode,
Claude Code or Codex projects.
