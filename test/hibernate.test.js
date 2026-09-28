const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const BIN = path.join(__dirname, "..", "bin", "hibernate.js");
const FAKE = path.join(__dirname, "fake-herdr.js");
fs.chmodSync(FAKE, 0o755);

const children = [];
const tmpDirs = [];
process.on("exit", () => {
  children.forEach((c) => { try { c.kill("SIGKILL"); } catch {} });
  tmpDirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true }));
});

function setup(state, extraEnv = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hibernate-test-"));
  tmpDirs.push(dir);
  const stateFile = path.join(dir, "herdr.json");
  fs.writeFileSync(stateFile, JSON.stringify(state));
  const env = {
    PATH: process.env.PATH,
    HOME: dir,
    HERDR_BIN_PATH: FAKE,
    FAKE_HERDR_STATE: stateFile,
    HERDR_PLUGIN_STATE_DIR: path.join(dir, "state"),
    HIBERNATE_EXIT_TIMEOUT_SECONDS: "1",
    ...extraEnv,
  };
  const run = (...args) => spawnSync(process.execPath, [BIN, ...args], { env, encoding: "utf8" });
  const runAsync = (args, moreEnv = {}) => new Promise((resolve) => {
    const c = spawn(process.execPath, [BIN, ...args], { env: { ...env, ...moreEnv } });
    let out = "";
    c.stdout.on("data", (d) => (out += d));
    c.on("exit", (code) => resolve({ code, out }));
  });
  const herdr = () => JSON.parse(fs.readFileSync(stateFile, "utf8"));
  const registry = () => {
    try { return JSON.parse(fs.readFileSync(path.join(env.HERDR_PLUGIN_STATE_DIR, "registry.json"), "utf8")); } catch { return {}; }
  };
  const writeRegistry = (reg) => {
    fs.mkdirSync(env.HERDR_PLUGIN_STATE_DIR, { recursive: true });
    fs.writeFileSync(path.join(env.HERDR_PLUGIN_STATE_DIR, "registry.json"), JSON.stringify(reg));
  };
  return { dir, env, run, runAsync, herdr, registry, writeRegistry };
}

/** A process standing in for the agent binary. Double-forked so it is not
 *  our child: like a real agent (reaped by the pane's shell) it vanishes on
 *  exit instead of lingering as a zombie while spawnSync blocks our loop. */
function fakeAgentProcess({ ignoreTerm = false } = {}) {
  const code = ignoreTerm ? "process.on('SIGTERM',()=>{});setInterval(()=>{},1e3)" : "setInterval(()=>{},1e3)";
  const r = spawnSync("sh", ["-c", `"${process.execPath}" -e "${code}" >/dev/null 2>&1 & echo $!`], { encoding: "utf8" });
  const pid = Number(r.stdout.trim());
  children.push({ kill: () => process.kill(pid, "SIGKILL") });
  const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
  return { pid, alive, kill: (sig) => process.kill(pid, sig) };
}

const agent = (over) => ({
  pane_id: "w1:p2", agent: "claude", agent_status: "idle", focused: false,
  terminal_id: "term_a", agent_session: { value: "sess-1" }, ...over,
});

const waitFor = async (pred, ms = 5000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
};

test("sleep signals the agent process and records the sleeper only after it exits", async () => {
  const proc = fakeAgentProcess();
  await new Promise((r) => setTimeout(r, 200)); // let node install its default signal handling
  const t = setup({ agents: [agent({ pid: proc.pid })] });
  const r = t.run("sleep-pane", "w1:p2");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(proc.alive(), false);
  const e = t.registry()["w1:p2"];
  assert.equal(e.kind, "claude");
  assert.equal(e.session_id, "sess-1");
  assert.equal(e.terminal_id, "term_a");
  // No keystrokes: nothing was typed into the composer.
  assert.ok(!t.herdr().calls.some((c) => c[1] === "prompt"));
});

test("sleep refuses when the agent ignores the exit and records nothing", async () => {
  const proc = fakeAgentProcess({ ignoreTerm: true });
  await new Promise((r) => setTimeout(r, 200));
  const t = setup({ agents: [agent({ pid: proc.pid })] });
  const r = t.run("sleep-pane", "w1:p2");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /still running/);
  assert.deepEqual(t.registry(), {});
  proc.kill("SIGKILL");
});

test("codex exits via typed /quit", () => {
  const t = setup({ agents: [agent({ agent: "codex" })] });
  const r = t.run("sleep-pane", "w1:p2");
  assert.equal(r.status, 0, r.stderr);
  assert.ok(t.herdr().calls.some((c) => c[1] === "prompt" && c[3] === "/quit"));
  assert.equal(t.registry()["w1:p2"].kind, "codex");
});

test("sleep refuses non-idle agents and agents without a session", () => {
  for (const [over, re] of [
    [{ agent_status: "working" }, /working/],
    [{ agent_status: "blocked" }, /blocked/],
    [{ agent_status: "unknown" }, /unknown/],
    [{ agent_session: null }, /no native session/],
    [{ agent: "gemini" }, /not hibernatable/],
  ]) {
    const t = setup({ agents: [agent(over)] });
    const r = t.run("sleep-pane", "w1:p2");
    assert.equal(r.status, 1);
    assert.match(r.stderr, re);
    assert.deepEqual(t.registry(), {});
  }
});

test("manual sleep may target the focused pane", () => {
  const t = setup({ agents: [agent({ agent: "codex", focused: true })] });
  assert.equal(t.run("sleep-pane", "w1:p2").status, 0);
});

test("HIBERNATE_AGENTS excludes kinds", () => {
  const t = setup({ agents: [agent({ agent: "codex" })] }, { HIBERNATE_AGENTS: "claude,opencode" });
  const r = t.run("sleep-pane", "w1:p2");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /not hibernatable/);
});

test("resume starts the agent with native resume argv and clears the entry", () => {
  const t = setup({ agents: [] });
  t.writeRegistry({ "w1:p2": { kind: "opencode", session_id: "ses_x", slept_at: 1 } });
  const r = t.run("resume", "w1:p2");
  assert.equal(r.status, 0, r.stderr);
  const start = t.herdr().calls.find((c) => c[1] === "start");
  assert.deepEqual(start.slice(3), ["--kind", "opencode", "--pane", "w1:p2", "--", "-s", "ses_x"]);
  assert.deepEqual(t.registry(), {});
});

test("resume treats agent_not_ready (startup dialog) as success", () => {
  const t = setup({ agents: [], start: "not_ready" });
  t.writeRegistry({ "w1:p2": { kind: "codex", session_id: "c1", slept_at: 1 } });
  const r = t.run("resume", "w1:p2");
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(t.registry(), {});
});

test("failed resume keeps the sleeper with the error", () => {
  const t = setup({ agents: [], start: "fail" });
  t.writeRegistry({ "w1:p2": { kind: "claude", session_id: "c1", slept_at: 1 } });
  const r = t.run("resume", "w1:p2");
  assert.equal(r.status, 1);
  assert.match(t.registry()["w1:p2"].last_resume_error, /pane_not_available/);
  // The lock was released: a later focus can retry.
  t.run("resume", "w1:p2");
  assert.equal(t.herdr().calls.filter((c) => c[1] === "start").length, 2);
});

test("resume drops the entry when the agent is already back in the pane", () => {
  const t = setup({ agents: [agent({ agent_session: { value: "other" } })] });
  t.writeRegistry({ "w1:p2": { kind: "claude", session_id: "sess-1", slept_at: 1 } });
  assert.equal(t.run("resume", "w1:p2").status, 0);
  assert.ok(!t.herdr().calls.some((c) => c[1] === "start"));
  assert.deepEqual(t.registry(), {});
});

test("concurrent focus hooks start the agent exactly once", async () => {
  const t = setup({ agents: [] });
  t.writeRegistry({ "w1:p2": { kind: "claude", session_id: "c1", slept_at: 1 } });
  const ev = JSON.stringify({ event: "pane_focused", data: { pane_id: "w1:p2", workspace_id: "w1" } });
  const results = await Promise.all(Array.from({ length: 6 }, () => t.runAsync(["on-focus"], { HERDR_PLUGIN_EVENT_JSON: ev })));
  assert.ok(results.every((r) => r.code === 0));
  assert.equal(t.herdr().calls.filter((c) => c[1] === "start").length, 1);
  assert.deepEqual(t.registry(), {});
});

test("legacy registry entries without kind resume as opencode", () => {
  const t = setup({ agents: [] });
  t.writeRegistry({ "w1:p2": { session_id: "ses_old", agent_name: "opencode", slept_at: 1 } });
  t.run("resume", "w1:p2");
  const start = t.herdr().calls.find((c) => c[1] === "start");
  assert.deepEqual(start.slice(3, 5), ["--kind", "opencode"]);
});

test("resume action takes the pane from plugin context", () => {
  const t = setup({ agents: [] }, { HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({ workspace_id: "w1", tab_id: "w1:t1", focused_pane_id: "w1:p2" }) });
  t.writeRegistry({ "w1:p2": { kind: "claude", session_id: "c1", slept_at: 1 } });
  assert.match(t.run("resume").stdout, /resumed session in w1:p2/);
});

test("named Herdr sessions get their own registry", () => {
  const t = setup({ agents: [agent({ agent: "codex" })] }, { HERDR_SESSION: "work" });
  assert.equal(t.run("sleep-pane", "w1:p2").status, 0);
  assert.deepEqual(t.registry(), {}); // default session's registry untouched
  const reg = JSON.parse(fs.readFileSync(path.join(t.env.HERDR_PLUGIN_STATE_DIR, "sessions", "work", "registry.json"), "utf8"));
  assert.equal(reg["w1:p2"].kind, "codex");
});

test("resume-all wakes every sleeper", () => {
  const t = setup({ agents: [] });
  t.writeRegistry({
    "w1:p2": { kind: "claude", session_id: "a", slept_at: 1 },
    "w1:p3": { kind: "opencode", session_id: "b", slept_at: 1 },
  });
  assert.equal(t.run("resume-all").status, 0);
  assert.equal(t.herdr().calls.filter((c) => c[1] === "start").length, 2);
  assert.deepEqual(t.registry(), {});
});

function stopWatcher(t) {
  try {
    const { pid } = JSON.parse(fs.readFileSync(path.join(t.env.HERDR_PLUGIN_STATE_DIR, "watcher.pid"), "utf8"));
    process.kill(pid, "SIGTERM");
  } catch {}
}

test("startup keeps a single watcher", async () => {
  const t = setup({ agents: [] });
  const outs = [t.run("startup").stdout, t.run("startup").stdout, t.run("startup").stdout];
  try {
    assert.match(outs[0], /spawned/);
    assert.match(outs[1], /already running/);
    assert.match(outs[2], /already running/);
    const pids = spawnSync("pgrep", ["-f", `${BIN} watch-loop`], { encoding: "utf8" }).stdout.trim().split("\n");
    const ours = pids.filter((p) => {
      try { return fs.readFileSync(`/proc/${p}/environ`, "utf8").includes(t.env.FAKE_HERDR_STATE); } catch { return false; }
    });
    if (fs.existsSync("/proc")) assert.equal(ours.length, 1);
  } finally {
    stopWatcher(t);
  }
});

test("watcher sleeps an idle unfocused agent after the window, never a focused one", async () => {
  const proc = fakeAgentProcess();
  const t = setup(
    {
      agents: [agent({ pid: proc.pid }), agent({ pane_id: "w1:p3", terminal_id: "term_b", agent: "opencode", focused: true, agent_session: { value: "s3" } })],
      panes: [{ pane_id: "w1:p2", terminal_id: "term_a" }, { pane_id: "w1:p3", terminal_id: "term_b" }],
    },
    { HIBERNATE_IDLE_MINUTES: "0.005", HIBERNATE_POLL_SECONDS: "0.1" },
  );
  t.run("startup");
  try {
    assert.ok(await waitFor(() => t.registry()["w1:p2"]), "idle pane was not slept");
    await new Promise((r) => setTimeout(r, 600));
    assert.equal(t.registry()["w1:p3"], undefined);
  } finally {
    stopWatcher(t);
  }
});

test("watcher prunes closed panes and follows moved ones", async () => {
  const t = setup(
    { agents: [], panes: [{ pane_id: "w2:p1", terminal_id: "term_moved" }] },
    { HIBERNATE_POLL_SECONDS: "0.1" },
  );
  t.writeRegistry({
    "w1:p2": { kind: "claude", session_id: "gone", terminal_id: "term_closed", slept_at: 1 },
    "w1:p3": { kind: "claude", session_id: "moved", terminal_id: "term_moved", slept_at: 1 },
  });
  t.run("startup");
  try {
    assert.ok(await waitFor(() => !t.registry()["w1:p2"] && t.registry()["w2:p1"]));
    assert.deepEqual(Object.keys(t.registry()), ["w2:p1"]);
    assert.equal(t.registry()["w2:p1"].session_id, "moved");
  } finally {
    stopWatcher(t);
  }
});

test("watcher never prunes on an empty pane list", async () => {
  const t = setup({ agents: [], panes: [] }, { HIBERNATE_POLL_SECONDS: "0.1" });
  t.writeRegistry({ "w1:p2": { kind: "claude", session_id: "keep", slept_at: 1 } });
  t.run("startup");
  try {
    await new Promise((r) => setTimeout(r, 400));
    assert.ok(t.registry()["w1:p2"]);
  } finally {
    stopWatcher(t);
  }
});

test("invalid HIBERNATE_IDLE_MINUTES falls back to the default", async () => {
  const t = setup({ agents: [] }, { HIBERNATE_IDLE_MINUTES: "soon" });
  t.run("startup");
  const logFile = path.join(t.env.HERDR_PLUGIN_STATE_DIR, "watch.log");
  try {
    assert.ok(await waitFor(() => fs.existsSync(logFile) && /window=1800000ms/.test(fs.readFileSync(logFile, "utf8"))));
    assert.match(fs.readFileSync(logFile, "utf8"), /ignoring invalid HIBERNATE_IDLE_MINUTES/);
  } finally {
    stopWatcher(t);
  }
});
