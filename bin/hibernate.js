#!/usr/bin/env node
/**
 * OpenCode Hibernate — a Herdr plugin (v1 manifest surface).
 *
 * Emulates agent hibernation for supported agent panes (opencode, claude,
 * codex):
 *   sleep  : when an agent pane has been idle past the threshold (and is
 *            not focused), end the agent process cleanly so the pane drops
 *            back to its shell. Record the pane + native session id in
 *            $HERDR_PLUGIN_STATE_DIR/registry.json — only once the agent is
 *            verified gone.
 *   resume : when a sleeper's pane is focused again, restart the agent in
 *            that same pane with its native resume flags.
 *
 * Per-agent profile (resume argv from Herdr's own agent_resume planner):
 *   opencode: exit SIGTERM            resume: -s <id>
 *   claude:   exit SIGTERM            resume: --resume <id>
 *   codex:    exit "/quit" (typed)    resume: resume <id>
 *
 * Why SIGTERM rather than typing /exit: `agent prompt` appends to whatever
 * is in the composer, so an unsent draft would be *submitted* as
 * "<draft>/exit" and run as a real turn. OpenCode and Claude Code both
 * handle SIGTERM gracefully (session already persisted, terminal modes
 * restored, draft discarded, never executed). Codex does not restore the
 * terminal's keyboard protocol on any signal, so it keeps the typed /quit.
 *
 * Lifecycle caveats: opencode reports authoritative lifecycle state via its
 * integration plugin; claude and codex state comes from Herdr's screen
 * manifest detection (their integrations only provide session identity).
 * State is re-checked immediately before exiting, and a blocked or working
 * pane is never slept.
 *
 * Herdr plugin v1 has no long-running daemon primitive, so the idle watcher
 * is a detached child spawned by the `startup` hook, kept to one instance
 * via watcher.pid.
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
// shell-launched instances (manual runs) get no env injection. Resolve the
// same layout from HOME so every entrypoint converges on one directory.
const PLUGIN_ID = "dalogax.opencode-hibernate";
const FALLBACK_STATE_DIR = path.join(
  process.env.HOME || ".",
  ".local", "state", "herdr", "plugins", PLUGIN_ID,
);
// Herdr's plugin state dir is shared by every Herdr session on the machine,
// but pane ids (w1:p2) are only unique within one session. Give each named
// session its own registry and watcher; the default session keeps the root.
const SESSION = process.env.HERDR_SESSION || "default";
const STATE_DIR = SESSION === "default"
  ? (process.env.HERDR_PLUGIN_STATE_DIR || FALLBACK_STATE_DIR)
  : path.join(process.env.HERDR_PLUGIN_STATE_DIR || FALLBACK_STATE_DIR, "sessions", SESSION.replace(/[^\w.-]/g, "_"));
const REGISTRY = path.join(STATE_DIR, "registry.json");
const REGISTRY_LOCK = path.join(STATE_DIR, "registry.lock");
const LOOP_PID = path.join(STATE_DIR, "watcher.pid");
const LOG = process.env.HIBERNATE_LOG || path.join(STATE_DIR, "watch.log");
const LOG_MAX_BYTES = 1_000_000;

// --- tunables (env overrides) -------------------------------------------------
function numberEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    log(`ignoring invalid ${name}=${JSON.stringify(raw)}; using ${fallback}`);
    return fallback;
  }
  return n;
}
const IDLE_WINDOW_MS = numberEnv("HIBERNATE_IDLE_MINUTES", 30) * 60_000;
const POLL_MS = numberEnv("HIBERNATE_POLL_SECONDS", 60) * 1000;
const EXIT_TIMEOUT_MS = numberEnv("HIBERNATE_EXIT_TIMEOUT_SECONDS", 15) * 1000;
// Watcher gives up after this many consecutive failed polls (server gone).
const MAX_POLL_FAILURES = 10;

/** Per-agent profile. argvResume receives the session id and returns the
 *  argv AFTER the binary (passed after `--` in `agent start`, which forwards
 *  everything to the agent executable). Exit is either a signal sent to the
 *  agent process or a command typed into the TUI composer. */
const AGENT_PROFILES = {
  opencode: { exitSignal: "SIGTERM", argvResume: (id) => ["-s", id] },
  claude: { exitSignal: "SIGTERM", argvResume: (id) => ["--resume", id] },
  codex: { exitCommand: "/quit", argvResume: (id) => ["resume", id] },
};
// HIBERNATE_AGENTS=opencode,claude restricts which kinds the plugin touches.
const HIBERNATABLE = (process.env.HIBERNATE_AGENTS || Object.keys(AGENT_PROFILES).join(","))
  .split(",").map((s) => s.trim().toLowerCase()).filter((k) => AGENT_PROFILES[k]);

// --- utils ----------------------------------------------------------------------
function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function log(msg) {
  try {
    fs.mkdirSync(path.dirname(LOG), { recursive: true });
    try {
      if (fs.statSync(LOG).size > LOG_MAX_BYTES) fs.renameSync(LOG, LOG + ".1");
    } catch {}
    fs.appendFileSync(LOG, `${new Date().toISOString()} [${process.pid}] ${msg}\n`);
  } catch {}
}

// --- registry -------------------------------------------------------------------
function readRegistry() {
  try {
    return JSON.parse(fs.readFileSync(REGISTRY, "utf8"));
  } catch {
    return {};
  }
}
function writeRegistry(reg) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const tmp = `${REGISTRY}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(reg, null, 2));
  fs.renameSync(tmp, REGISTRY);
}

/** Read-modify-write the registry under a cross-process lock, so the
 *  watcher and concurrent focus hooks can't drop each other's updates. */
function updateRegistry(fn) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      fs.mkdirSync(REGISTRY_LOCK);
      break;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      try {
        // A holder that crashed mid-update leaves the lock behind.
        if (Date.now() - fs.statSync(REGISTRY_LOCK).mtimeMs > 30_000) {
          fs.rmdirSync(REGISTRY_LOCK);
          continue;
        }
      } catch {}
      if (Date.now() > deadline) throw new Error("registry lock timeout");
      sleepMs(25);
    }
  }
  try {
    const reg = readRegistry();
    const result = fn(reg);
    writeRegistry(reg);
    return result;
  } finally {
    try { fs.rmdirSync(REGISTRY_LOCK); } catch {}
  }
}

// --- herdr CLI wrappers ---------------------------------------------------------
function herdr(args) {
  const r = spawnSync(HERDR, args, { encoding: "utf8" });
  if (r.status !== 0) {
    // Errors come back as {"error":{"code":...}} JSON on stderr.
    const detail = (r.stderr || r.stdout || "").trim();
    const err = new Error(`herdr ${args.join(" ")} failed (exit ${r.status}): ${detail}`);
    try { err.code = JSON.parse(detail)?.error?.code; } catch {}
    throw err;
  }
  return r.stdout;
}
function herdrJson(args) {
  return JSON.parse(herdr(args));
}

/** Every agent pane, normalized; only hibernatable kinds unless `all`. */
function listAgents({ all = false } = {}) {
  const snap = herdrJson(["agent", "list"]); // CLI is JSON-only
  const agents = (snap?.result?.agents || []).map(normalizeAgent);
  return all ? agents : agents.filter((a) => HIBERNATABLE.includes(a.kind));
}

/** The agent currently in `paneId`, null if the pane hosts none. Throws on
 *  any other failure (socket down etc.) so callers never mistake an
 *  unreachable server for "the agent exited". */
function agentInPane(paneId) {
  try {
    return normalizeAgent(herdrJson(["agent", "get", paneId]).result.agent);
  } catch (e) {
    if (e.code === "agent_not_found") return null;
    throw e;
  }
}

function normalizeAgent(a) {
  const kind = (a.agent || "").toLowerCase();
  return {
    pane_id: a.pane_id,
    terminal_id: a.terminal_id || null,
    kind,
    name: a.name || null, // user-given agent name, if any
    state: a.agent_status,
    seq: a.state_change_seq ?? null,
    session: a.agent_session?.value || null,
    focused: !!a.focused,
  };
}

// --- sleep ----------------------------------------------------------------------
/** Refuse unless, right now, the agent is idle/done (never working, blocked
 *  or unknown) and — for the watcher — not the pane you are looking at. */
function assertSleepable(paneId, { allowFocused = false } = {}) {
  const norm = agentInPane(paneId);
  if (!norm) throw new Error(`${paneId} hosts no agent`);
  if (norm.state !== "idle" && norm.state !== "done") {
    throw new Error(`${paneId} is ${norm.state} — refusing to sleep a non-idle agent`);
  }
  if (norm.focused && !allowFocused) {
    throw new Error(`${paneId} is the focused pane — refusing to sleep an on-screen agent`);
  }
  if (!HIBERNATABLE.includes(norm.kind)) {
    throw new Error(`${paneId}: agent kind "${norm.kind}" is not hibernatable`);
  }
  if (!norm.session) {
    throw new Error(`${paneId} has no native session reference yet — send it a message first, and make sure the integration is installed (herdr integration install ${norm.kind})`);
  }
  return norm;
}

/** The agent's own process in the pane's foreground (not the shell, not
 *  helper children). */
function agentPid(paneId, kind) {
  const info = herdrJson(["pane", "process-info", "--pane", paneId]).result.process_info;
  const procs = info.foreground_processes || [];
  const base = (p) => path.basename(p.argv?.[0] || "");
  const match = procs.find((p) => p.name === kind || base(p) === kind)
    || procs.find((p) => p.pid === info.foreground_process_group_id);
  if (!match || !match.pid || match.pid === info.shell_pid) {
    throw new Error(`${paneId}: cannot find the ${kind} process (foreground: ${procs.map((p) => p.name).join(",") || "none"})`);
  }
  return match.pid;
}

function waitForExit(paneId, session) {
  const deadline = Date.now() + EXIT_TIMEOUT_MS;
  for (;;) {
    const cur = agentInPane(paneId);
    if (!cur || cur.session !== session) return true;
    if (Date.now() > deadline) return false;
    sleepMs(250);
  }
}

function sleepPane(paneId, { manual = false } = {}) {
  const norm = assertSleepable(paneId, { allowFocused: manual });
  const profile = AGENT_PROFILES[norm.kind];

  let how;
  if (profile.exitSignal) {
    const pid = agentPid(paneId, norm.kind);
    process.kill(pid, profile.exitSignal);
    how = `${profile.exitSignal} to pid ${pid}`;
  } else {
    // `agent prompt` writes text plus a bracketed-paste-aware Enter and
    // rejects a blocked agent. Caveat: an unsent draft in the composer gets
    // the command appended to it (see README).
    herdr(["agent", "prompt", paneId, profile.exitCommand]);
    how = `"${profile.exitCommand}"`;
  }

  if (!waitForExit(paneId, norm.session)) {
    throw new Error(`${paneId}: ${norm.kind} still running ${EXIT_TIMEOUT_MS / 1000}s after ${how}; not recorded as hibernated`);
  }

  updateRegistry((reg) => {
    reg[paneId] = {
      kind: norm.kind,
      session_id: norm.session,
      agent_name: norm.name,
      terminal_id: norm.terminal_id,
      slept_at: Date.now(),
      idle_window_ms: IDLE_WINDOW_MS,
    };
  });
  log(`slept ${paneId}[${norm.kind}] session=${norm.session} via ${how}${manual ? " (manual)" : ""}`);
  return norm;
}

// --- resume ---------------------------------------------------------------------
/** Per-pane wake lock: one click fires several pane.focused hooks
 *  (workspace -> tab -> pane); only the first may resume. Atomic create, so
 *  two hooks can't both win. */
function acquireWakeLock(paneId) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const lock = path.join(STATE_DIR, `.${paneId.replace(/[^a-zA-Z0-9]/g, "_")}.wake`);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(lock, String(process.pid), { flag: "wx" });
      return () => { try { fs.unlinkSync(lock); } catch {} };
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      try {
        // agent start waits up to 30s; anything older is a dead holder.
        if (Date.now() - fs.statSync(lock).mtimeMs < 120_000) return null;
        fs.unlinkSync(lock);
      } catch {}
    }
  }
  return null;
}

function entryKind(entry) {
  if (entry.kind && AGENT_PROFILES[entry.kind]) return entry.kind;
  // Registries written before multi-agent support have no `kind`; those
  // versions were OpenCode-only.
  const inferred = (entry.agent_name || "opencode").toLowerCase();
  return Object.keys(AGENT_PROFILES).find((k) => inferred.includes(k)) || "opencode";
}

function resumePane(paneId) {
  if (!readRegistry()[paneId]) return false; // cheap path for ordinary focus events

  const release = acquireWakeLock(paneId);
  if (!release) return false; // another hook from the same click is on it
  try {
    // Take the entry under the lock; a crashed hook can then never
    // resurrect the sleeper, and only a verified failure puts it back.
    const entry = updateRegistry((reg) => {
      const e = reg[paneId];
      delete reg[paneId];
      return e;
    });
    if (!entry) return false;
    const kind = entryKind(entry);

    const running = () => {
      try { return agentInPane(paneId)?.kind === kind; } catch { return false; }
    };
    if (running()) {
      log(`resume ${paneId}: ${kind} already running there; dropping sleeper entry`);
      return true;
    }

    const argv = AGENT_PROFILES[kind].argvResume(entry.session_id);
    const start = (name) => herdr(["agent", "start", name, "--kind", kind, "--pane", paneId, "--", ...argv]);
    // `agent start` requires an available shell pane — which is exactly what
    // a cleanly-exited sleeper is. It also requires a name unique among live
    // agents: keep the agent's own name when it had one, else a unique one.
    const unique = `${kind}-${paneId.replace(/[^a-z0-9]/gi, "").toLowerCase()}-${Date.now().toString(36)}`;
    const own = /^[a-z][a-z0-9_-]{0,31}$/.test(entry.agent_name || "") ? entry.agent_name : null;
    try {
      try {
        start(own || unique);
      } catch (e) {
        if (!own || e.code !== "agent_name_taken") throw e;
        start(unique); // the old name is taken by another live agent now
      }
    } catch (e) {
      // agent_not_ready = launched but waiting on a startup dialog (trust
      // prompt, update notice). The user is looking at it; that's a resume.
      // Otherwise, if the agent is in the pane anyway, a racing hook won.
      if (e.code === "agent_not_ready" || running()) {
        log(`resume ${paneId}: ${kind} started (${e.code || "raced"})`);
        return true;
      }
      updateRegistry((reg) => {
        reg[paneId] = { ...entry, kind, last_resume_error: String(e.message || e).slice(0, 300) };
      });
      log(`resume-failed ${paneId}: ${e.message}`);
      throw e;
    }
    log(`resumed ${paneId}[${kind}] session=${entry.session_id}`);
    return true;
  } finally {
    release();
  }
}

// --- registry hygiene -------------------------------------------------------------
/** Drop entries for closed panes; follow panes that moved (new pane id,
 *  same terminal). Pane ids are never reused, so a missing id is final. */
function pruneRegistry() {
  if (Object.keys(readRegistry()).length === 0) return;
  const panes = herdrJson(["pane", "list"]).result?.panes;
  // A live server always has at least one pane; anything else is a bad
  // read, and dropping every sleeper on a bad read would be unrecoverable.
  if (!Array.isArray(panes) || panes.length === 0) return;
  const ids = new Set(panes.map((p) => p.pane_id));
  const byTerminal = new Map(panes.map((p) => [p.terminal_id, p.pane_id]));
  updateRegistry((reg) => {
    for (const [paneId, entry] of Object.entries(reg)) {
      if (ids.has(paneId)) continue;
      const moved = entry.terminal_id && byTerminal.get(entry.terminal_id);
      if (moved && !reg[moved]) {
        reg[moved] = entry;
        log(`registry: ${paneId} moved to ${moved}`);
      } else {
        log(`registry: dropped ${paneId} (pane closed; session ${entry.session_id})`);
      }
      delete reg[paneId];
    }
  });
}

// --- idle watcher (detached loop started by `startup`) ------------------------------
/** Identifies the code a watcher runs, so an upgrade replaces old watchers. */
function codeStamp() {
  const st = fs.statSync(__filename);
  return `${st.mtimeMs}:${st.size}`;
}

function readWatcherPid() {
  try {
    const raw = fs.readFileSync(LOOP_PID, "utf8").trim();
    return raw.startsWith("{") ? JSON.parse(raw) : { pid: Number(raw), stamp: null };
  } catch {
    return null;
  }
}

/** Alive AND actually our watcher (guards against pid reuse). */
function isWatcherProcess(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); } catch { return false; }
  const r = spawnSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" });
  return r.status === 0 && r.stdout.includes("watch-loop");
}

function ensureWatcher() {
  const cur = readWatcherPid();
  if (cur && isWatcherProcess(cur.pid)) {
    if (cur.stamp === codeStamp()) return `watcher already running (pid ${cur.pid})`;
    try { process.kill(cur.pid, "SIGTERM"); } catch {}
    log(`replacing watcher pid=${cur.pid} (plugin code changed)`);
  }
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const child = spawn(process.execPath, [__filename, "watch-loop"], {
    detached: true,
    stdio: "ignore",
    // Inherits HERDR_SOCKET_PATH/HERDR_SESSION, so it polls this server.
    env: process.env,
  });
  child.unref();
  fs.writeFileSync(LOOP_PID, JSON.stringify({ pid: child.pid, stamp: codeStamp() }));
  return `watcher spawned (pid ${child.pid})`;
}

function watchLoop() {
  // Normally ensureWatcher already wrote our pid; claim it when run by hand.
  const claimed = readWatcherPid();
  if (!claimed || claimed.pid !== process.pid) {
    if (claimed && isWatcherProcess(claimed.pid)) {
      console.log(`watcher already running (pid ${claimed.pid})`);
      return;
    }
    fs.writeFileSync(LOOP_PID, JSON.stringify({ pid: process.pid, stamp: codeStamp() }));
  }

  log(`watcher start window=${IDLE_WINDOW_MS}ms poll=${POLL_MS}ms agents=${HIBERNATABLE.join(",")}`);
  const idleSince = new Map(); // pane_id -> ms the current idle stretch began
  const lastSeq = new Map(); // pane_id -> state_change_seq seen last tick
  const lastState = new Map(); // pane_id -> "state(focused)" for change-only logging
  let failures = 0;

  const tick = () => {
    if (readWatcherPid()?.pid !== process.pid) {
      log("watcher superseded; exiting");
      process.exit(0);
    }
    let panes;
    try {
      panes = listAgents();
      failures = 0;
    } catch (e) {
      // The session's server was stopped; the next server start runs the
      // startup hook and spawns a fresh watcher.
      if (e.code === "server_not_running" || ++failures >= MAX_POLL_FAILURES) {
        log(e.code === "server_not_running"
          ? "herdr server stopped; exiting"
          : `herdr unreachable for ${failures} polls; exiting (${e.message})`);
        process.exit(0);
      }
      log(`tick-error: ${e.message}`);
      return;
    }

    const now = Date.now();
    const seen = new Set();
    for (const p of panes) {
      seen.add(p.pane_id);
      const desc = `${p.kind}=${p.state}${p.focused ? "(focused)" : ""}`;
      if (lastState.get(p.pane_id) !== desc) log(`state ${p.pane_id} ${desc}`);
      lastState.set(p.pane_id, desc);

      // A state change between polls (idle -> working -> idle within one
      // interval) still restarts the idle clock.
      const seqChanged = p.seq !== null && lastSeq.has(p.pane_id) && lastSeq.get(p.pane_id) !== p.seq;
      lastSeq.set(p.pane_id, p.seq);

      // `done` = idle-but-unviewed: still safe to sleep, and its clock must
      // accrue too or background-finished panes never reach the threshold.
      const sleepable = (p.state === "idle" || p.state === "done") && !p.focused;
      if (!sleepable) { idleSince.delete(p.pane_id); continue; }
      if (seqChanged || !idleSince.has(p.pane_id)) idleSince.set(p.pane_id, now);
      if (now - idleSince.get(p.pane_id) < IDLE_WINDOW_MS) continue;
      try {
        sleepPane(p.pane_id);
        idleSince.delete(p.pane_id);
      } catch (e) {
        // e.g. pane got busy/focused since the list; keep its timer running.
        log(`sleep-refused ${p.pane_id}: ${e.message}`);
      }
    }
    for (const id of [...idleSince.keys()]) if (!seen.has(id)) idleSince.delete(id);
    for (const id of [...lastSeq.keys()]) if (!seen.has(id)) { lastSeq.delete(id); lastState.delete(id); }

    try { pruneRegistry(); } catch (e) { log(`prune-error: ${e.message}`); }
  };

  process.on("SIGTERM", () => { log("watcher stopped (SIGTERM)"); process.exit(0); });
  tick();
  setInterval(tick, POLL_MS);
}

// --- CLI ------------------------------------------------------------------------
function contextPane(args) {
  // Action context (verified live, herdr 0.9.0):
  //   {"workspace_id":"w1","tab_id":"w1:t1","focused_pane_id":"w1:p2",...}
  const ctx = JSON.parse(process.env.HERDR_PLUGIN_CONTEXT_JSON || "{}");
  return args[0] || ctx.focused_pane_id || ctx.pane_id
    // Herdr also sets HERDR_PANE_ID for plugin commands; outside a plugin
    // command it is the caller's own pane, so don't fall back to it there.
    || (process.env.HERDR_PLUGIN_ID ? process.env.HERDR_PANE_ID : null)
    || null;
}

function main(cmd, args) {
  switch (cmd) {
    case "startup":
      console.log(ensureWatcher());
      break;

    case "watch-loop":
      watchLoop();
      break;

    case "sleep-pane": {
      const pane = contextPane(args);
      if (!pane) throw new Error("no pane context; pass a pane id: hibernate.js sleep-pane w1:p2");
      // An explicit request may sleep the focused pane; it still has to be idle.
      sleepPane(pane, { manual: true });
      console.log(`slept ${pane}`);
      break;
    }

    case "resume": {
      const pane = contextPane(args);
      if (!pane) throw new Error("pass a pane id: hibernate.js resume w1:p2");
      console.log(resumePane(pane) ? `resumed session in ${pane}` : `${pane} is not hibernated`);
      break;
    }

    case "resume-all": {
      const failed = [];
      for (const pane of Object.keys(readRegistry())) {
        try {
          if (resumePane(pane)) console.log(`resumed ${pane}`);
        } catch (e) {
          failed.push(pane);
          console.error(`${pane}: ${e.message}`);
        }
      }
      if (failed.length) process.exitCode = 1;
      break;
    }

    case "on-focus": {
      const raw = process.env.HERDR_PLUGIN_EVENT_JSON || "{}";
      if (process.env.HIBERNATE_DEBUG) log(`event ${raw}`);
      // Payload shape (verified live):
      //   {"event":"pane_focused","data":{"type":"pane_focused","pane_id":"w1:p2","workspace_id":"w1"}}
      const ev = JSON.parse(raw);
      const d = ev.data || ev;
      const pane = d.pane_id || d.paneId || d.focused_pane_id;
      if (pane && resumePane(pane)) console.log(`auto-resumed ${pane}`);
      break;
    }

    case "list": {
      const rows = Object.entries(readRegistry()).map(([pane, e]) => ({
        pane,
        kind: entryKind(e),
        session: e.session_id,
        slept_at: new Date(e.slept_at).toISOString(),
        ...(e.last_resume_error ? { last_error: e.last_resume_error } : {}),
      }));
      console.log(JSON.stringify(rows, null, 2));
      break;
    }

    default:
      console.log("usage: hibernate.js <startup|watch-loop|sleep-pane|resume|resume-all|list|on-focus> [pane_id]");
      process.exitCode = 2;
  }
}

if (require.main === module) {
  const [, , cmd, ...args] = process.argv;
  try {
    main(cmd, args);
  } catch (e) {
    console.error(String(e.message || e));
    process.exit(1);
  }
}

module.exports = { AGENT_PROFILES, entryKind, normalizeAgent };
