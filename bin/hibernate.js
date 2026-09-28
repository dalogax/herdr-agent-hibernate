#!/usr/bin/env node
/**
 * OpenCode Hibernate — a Herdr plugin (v1 manifest surface).
 *
 * Emulates agent hibernation for supported agent panes (opencode, claude,
 * codex):
 *   sleep  : when an agent pane has been idle past the threshold (and is
 *            not focused), submit its exit command so the TUI exits cleanly
 *            back to a shell. Record the pane + native session id in
 *            $HERDR_PLUGIN_STATE_DIR/registry.json.
 *   resume : when a sleeper's pane is focused again, restart the agent in
 *            that same pane with its native resume flags.
 *
 * Per-agent profile (from Herdr's own agent_resume planner):
 *   opencode: exit "/exit"            resume: -s <id>
 *   claude:   exit "/exit"            resume: --resume <id>
 *   codex:    exit "/quit"            resume: resume <id>
 *
 * Lifecycle caveats: opencode reports authoritative lifecycle state via its
 * integration plugin; claude and codex state comes from Herdr's screen
 * manifest detection (their integrations only provide session identity).
 * Screen-detected `idle` can occasionally be a misread, and the /exit or
 * /quit prompt lands harmlessly at the composer if so — but state is
 * re-checked immediately before sending, and a blocked or working pane is
 * never slept.
 *
 * Herdr plugin v1 has no long-running daemon primitive, so the idle watcher
 * is a detached child spawned (once) by the `startup` hook. Event hooks and
 * actions are one-shot commands Herdr starts when needed.
 *
 * Herdr CLI notes (0.9.1): `agent list` / `agent get` are JSON-only (no
 * --json flag). `agent start` waits for readiness; after a clean exit the
 * pane is an available shell pane again, which is exactly what `agent start
 * --pane` requires.
 *
 * Env injected by Herdr:
 *   HERDR_BIN_PATH, HERDR_PLUGIN_STATE_DIR, HERDR_PLUGIN_CONTEXT_JSON,
 *   HERDR_PLUGIN_EVENT_JSON (event hooks)
 */

const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const HERDR = process.env.HERDR_BIN_PATH || "herdr";
// Single source of truth for state. Herdr injects HERDR_PLUGIN_STATE_DIR
// (e.g. ~/.local/state/herdr/plugins/<id>) when running hooks/actions, but
// shell-launched instances (the detached watcher, manual runs) get no env
// injection. Resolve the same layout from HOME so every entrypoint converges
// on one directory.
const PLUGIN_ID = "dalogax.opencode-hibernate";
const FALLBACK_STATE_DIR = path.join(
  process.env.HOME || ".",
  ".local", "state", "herdr", "plugins", PLUGIN_ID,
);
const STATE_DIR = process.env.HERDR_PLUGIN_STATE_DIR || FALLBACK_STATE_DIR;
const REGISTRY = path.join(STATE_DIR, "registry.json");
const LOOP_PID = path.join(STATE_DIR, "watcher.pid");

// --- tunables (env overrides; config file later) ---------------------------
const IDLE_WINDOW_MIN = Number(process.env.HIBERNATE_IDLE_MINUTES || 30);
const IDLE_WINDOW_MS = IDLE_WINDOW_MIN * 60_000;

// --- registry ---------------------------------------------------------------
function readRegistry() {
  try {
    return JSON.parse(fs.readFileSync(REGISTRY, "utf8"));
  } catch {
    return {};
  }
}
function writeRegistry(reg) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const tmp = REGISTRY + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(reg, null, 2));
  fs.renameSync(tmp, REGISTRY);
}

// --- herdr CLI wrappers ------------------------------------------------------
function herdr(args) {
  const r = spawnSync(HERDR, args, { encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`herdr ${args.join(" ")} failed (exit ${r.status}): ${r.stderr || r.stdout}`);
  }
  return r.stdout;
}
function herdrJson(args) {
  return JSON.parse(herdr(args));
}

/** Per-agent profile. argvResume receives the session id and returns the
 *  argv AFTER the binary (passed after `--` in `agent start`, which forwards
 *  everything to the agent executable). exitCommand is typed into the TUI
 *  composer to end the session cleanly. */
const AGENT_PROFILES = {
  opencode: { exitCommand: "/exit", argvResume: (id) => ["-s", id] },
  claude: { exitCommand: "/exit", argvResume: (id) => ["--resume", id] },
  codex: { exitCommand: "/quit", argvResume: (id) => ["resume", id] },
};
const HIBERNATABLE = Object.keys(AGENT_PROFILES);

/** Full pane+agent metadata for every pane hosting a hibernatable agent. */
function listHibernatableAgents() {
  const snap = herdrJson(["agent", "list"]); // CLI is JSON-only
  const agents = (snap?.result?.agents) || [];
  return agents.filter((a) => HIBERNATABLE.includes((a.agent || "").toLowerCase()));
}

function agentGet(target) {
  try {
    return herdrJson(["agent", "get", target]); // CLI is JSON-only
  } catch {
    return null;
  }
}

function normalizeAgent(a) {
  const kind = (a.agent || "").toLowerCase();
  return {
    pane_id: a.pane_id,
    kind,
    name: a.name || a.agent || kind,
    state: a.agent_status,
    session: a.agent_session?.value || null,
    focused: !!a.focused,
  };
}

// --- sleep -------------------------------------------------------------------
/** Send /exit only if, at send time, the agent is still idle and unfocused
 *  (never blocked/working/unknown, never the pane you are looking at). */
function assertStillIdle(target) {
  // Recheck at send time: `done` is also fine (idle-but-unviewed);
  // anything else (working/blocked/unknown) or focused is refused.
  const info = agentGet(target);
  const a = info && info.result?.agent;
  const norm = a ? normalizeAgent(a) : null;
  const okState = norm && (norm.state === "idle" || norm.state === "done");
  if (!okState) {
    throw new Error(`${target} is ${norm ? norm.state : "unresolvable"} — refusing to sleep a non-idle agent`);
  }
  if (norm.focused) {
    throw new Error(`${target} is the focused pane — refusing to sleep an on-screen agent`);
  }
  return norm;
}

function sleepPane(paneId) {
  const norm = assertStillIdle(paneId);
  const profile = AGENT_PROFILES[norm.kind];
  if (!profile) throw new Error(`${paneId}: agent kind "${norm.kind}" is not hibernatable`);
  if (!norm.session) {
    throw new Error(`${paneId} has no native session reference — install the ${norm.kind} integration first (herdr integration install ${norm.kind})`);
  }

  // Politely exit the TUI: `agent prompt` writes text plus a delayed,
  // bracketed-paste-aware Enter and requires an idle/unblocked agent —
  // exactly the safety profile we want for an exit command.
  herdr(["agent", "prompt", paneId, profile.exitCommand]);

  const reg = readRegistry();
  reg[norm.pane_id] = {
    kind: norm.kind,
    session_id: norm.session,
    agent_name: norm.name,
    slept_at: Date.now(),
    idle_window_ms: IDLE_WINDOW_MS,
  };
  writeRegistry(reg);
  return true;
}

// --- resume ------------------------------------------------------------------
/** Per-pane wake lock: concurrent pane.focused events (workspace->tab->pane)
 *  fire several hooks per click; only the first may resume. */
function wakeLockFresh(paneId) {
  const lock = path.join(STATE_DIR, `.${paneId.replace(/[^a-zA-Z0-9]/g, "_")}.wake`);
  try {
    if (Date.now() - fs.statSync(lock).mtimeMs < 20000) return true;
  } catch {}
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(lock, String(Date.now()));
  } catch {}
  return false;
}

function resumePane(paneId) {
  const reg = readRegistry();
  const entry = reg[paneId];
  if (!entry) return false;

  // Backward compatibility: registries written before multi-agent support
  // have no `kind`. Infer from the recorded agent name (older versions were
  // OpenCode-only, so that stays the default).
  if (!entry.kind || !AGENT_PROFILES[entry.kind]) {
    const inferred = (entry.agent_name || "opencode").toLowerCase();
    entry.kind = HIBERNATABLE.find((k) => inferred.includes(k)) || "opencode";
  }


  // Another hook from the same click already started the wake — don't race it.
  if (wakeLockFresh(paneId)) return false;

  // Delete first so a crashed hook can never resurrect the sleeper; only a
  // genuine failure (verified below) puts it back.
  delete reg[paneId];
  writeRegistry(reg);

  // Agent names must be unique among live agents: never reuse a fixed name,
  // or two sleepers waking together will collide and one stays asleep.
  const name = "hz-" + String(paneId).replace(/[^a-z0-9]/gi, "").toLowerCase() + "-" + Date.now().toString(36);
  const resumeArgv = AGENT_PROFILES[entry.kind].argvResume(entry.session_id);
  try {
    // `agent start` requires an available shell pane — which is exactly what
    // a cleanly-exited sleeper is.
    herdr([
      "agent", "start", name,
      "--kind", entry.kind,
      "--pane", paneId,
      "--", ...resumeArgv,
    ]);
  } catch (e) {
    // If the pane now hosts an agent with our session id, a racing
    // hook already resumed it — that is success, not failure.
    let resumedByRace = false;
    try {
      const cur = agentGet(paneId);
      resumedByRace = cur?.result?.agent?.agent_session?.value === entry.session_id;
    } catch {}
    if (resumedByRace) return true;
    reg[paneId] = { ...entry, last_resume_error: String(e.message || e).slice(0, 200) };
    writeRegistry(reg);
    throw e;
  }
  return true;
}

// --- idle watcher (detached loop started by `startup`) -----------------------
function spawnWatcher() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const child = spawn(process.execPath, [__filename, "watch-loop"], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, HERDR_PLUGIN_STATE_DIR: STATE_DIR }, // pin the state dir explicitly
  });
  child.unref();
  fs.writeFileSync(LOOP_PID, String(child.pid));
}

function watchLoop(argv) {
  if (argv[0]) {
    // Only one loop per machine: adopt the new one, ignore older ones.
    fs.writeFileSync(LOOP_PID, String(process.pid));
  } else if (fs.existsSync(LOOP_PID)) {
    const pid = Number(fs.readFileSync(LOOP_PID, "utf8").trim());
    if (pid && pid !== process.pid) {
      try {
        process.kill(pid, 0); // alive
        console.log(`watcher already running (pid ${pid})`);
        return;
      } catch {
        /* stale, take over */
      }
    }
    fs.writeFileSync(LOOP_PID, String(process.pid));
  }

  const POLL_MS = 60_000;
  const LOG = process.env.HIBERNATE_LOG || path.join(STATE_DIR, "watch.log");
  const log = (msg) => {
    try { fs.appendFileSync(LOG, `${new Date().toISOString()} ${msg}\n`); } catch {}
  };
  log(`watcher start pid=${process.pid} window=${IDLE_WINDOW_MS}ms`);
  // idle_since: pane_id -> first-idle timestamp (ms). Reset on any non-idle state.
  const idleSince = new Map();

  const tick = () => {
    let panes;
    try {
      panes = listHibernatableAgents().map(normalizeAgent);
    } catch (e) {
      log(`tick-error: ${e.message}`);
      return; // transient CLI/socket error; retry next tick
    }
    log(`tick: ${panes.map(p => `${p.pane_id}[${p.kind}]=${p.state}${p.focused ? "(focused)" : ""}`).join(" ") || "no-agents"}`);
    const now = Date.now();
    for (const p of panes) {
      // `done` = idle-but-unviewed in Herdr's lifecycle authority: still safe
      // to sleep, and its idle clock must accrue too or background-finished
      // panes never reach the threshold.
      const sleepable = p.state === "idle" || p.state === "done";
      if (p.focused) { idleSince.delete(p.pane_id); continue; } // never sleep on-screen panes
      if (sleepable) {
        if (!idleSince.has(p.pane_id)) idleSince.set(p.pane_id, now);
        if (now - idleSince.get(p.pane_id) >= IDLE_WINDOW_MS) {
          try {
            sleepPane(p.pane_id);
            idleSince.delete(p.pane_id);
            log(`slept ${p.pane_id}[${p.kind}] (session ${p.session})`);
          } catch (e) {
            // e.g. pane got blocked between ticks; keep timer running.
            log(`sleep-refused ${p.pane_id}: ${e.message}`);
          }
        }
      } else {
        idleSince.delete(p.pane_id);
      }
    }  };

  setInterval(tick, POLL_MS);
}

// --- CLI ---------------------------------------------------------------------
const [, , cmd, ...args] = process.argv;

try {
  switch (cmd) {
    case "startup":
      spawnWatcher();
      console.log("watcher spawned");
      break;

    case "watch-loop":
      watchLoop(args);
      break;

    case "sleep-pane": {
      // Action context: the pane was in HERDR_PLUGIN_CONTEXT_JSON.
      const ctx = JSON.parse(process.env.HERDR_PLUGIN_CONTEXT_JSON || "{}");
      const pane = ctx.pane_id || ctx.pane?.pane_id || args[0];
      if (!pane) throw new Error("no pane context; pass a pane id: hibernate.js sleep-pane w1:p2");
      sleepPane(pane);
      console.log(`slept ${pane}`);
      break;
    }

    case "resume": {
      const ctx = JSON.parse(process.env.HERDR_PLUGIN_CONTEXT_JSON || "{}");
      const pane = ctx.pane_id || ctx.pane?.pane_id || args[0];
      if (!pane) throw new Error("pass a pane id: hibernate.js resume w1:p2");
      if (!resumePane(pane)) console.log(`${pane} is not hibernated`);
      else console.log(`resumed session in ${pane}`);
      break;
    }

    case "on-focus": {
      // Debug: capture the raw payload so field names are provable, not guessed.
      try {
        fs.mkdirSync(STATE_DIR, { recursive: true });
        fs.appendFileSync(
          path.join(STATE_DIR, "events.log"),
          new Date().toISOString() + " " + (process.env.HERDR_PLUGIN_EVENT_JSON || "{}") + "\n",
        );
      } catch {}
      const ev = JSON.parse(process.env.HERDR_PLUGIN_EVENT_JSON || "{}");
      // Real payload shape (verified live):
      //   {"event":"pane_focused","data":{"pane_id":"w6:p1","workspace_id":"w6"}}
      const d = ev.data || ev;
      const pane = d.pane_id || d.paneId || d.focused_pane_id;
      if (pane && resumePane(pane)) console.log(`auto-resumed ${pane}`);
      break;
    }

    case "list": {
      const reg = readRegistry();
      const rows = Object.entries(reg).map(([pane, e]) => ({
        pane,
        kind: e.kind,
        session: e.session_id,
        slept_at: new Date(e.slept_at).toISOString(),
        last_error: e.last_resume_error,
      }));
      console.log(JSON.stringify(rows, null, 2));
      break;
    }

    default:
      console.log("usage: hibernate.js <startup|watch-loop|sleep-pane|resume|list|on-focus> [pane_id]");
      process.exit(2);
  }
} catch (e) {
  console.error(String(e.message || e));
  process.exit(1);
}
