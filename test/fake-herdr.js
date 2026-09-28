#!/usr/bin/env node
// Minimal stand-in for the herdr CLI, driven by the JSON file at
// $FAKE_HERDR_STATE. Implements only the calls hibernate.js makes. Every
// invocation is appended to state.calls.
//
// state = {
//   agents: [{ pane_id, agent, agent_status, focused, terminal_id,
//              agent_session: { value }, pid }],   // pid: agent gone once dead
//   panes:  [{ pane_id, terminal_id }],
//   start:  "ok" | "not_ready" | "fail",           // agent start behaviour
//   exitOnPrompt: true,                             // typed exit command works
// }
const fs = require("node:fs");

const file = process.env.FAKE_HERDR_STATE;

function withState(fn) {
  // Serialize concurrent invocations (focus-hook races) with a lock dir.
  const lock = file + ".lock";
  for (;;) {
    try { fs.mkdirSync(lock); break; } catch { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5); }
  }
  try {
    const state = JSON.parse(fs.readFileSync(file, "utf8"));
    const out = fn(state);
    fs.writeFileSync(file, JSON.stringify(state, null, 2));
    return out;
  } finally {
    fs.rmdirSync(lock);
  }
}

function alive(pid) {
  if (!pid) return true;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

const ok = (result) => ({ code: 0, out: { id: "fake", result } });
const fail = (code) => ({ code: 1, out: { id: "fake", error: { code, message: code } } });

const args = process.argv.slice(2);
const res = withState((s) => {
  s.calls = s.calls || [];
  s.calls.push(args);
  s.agents = (s.agents || []).filter((a) => alive(a.pid));
  const find = (t) => s.agents.find((a) => a.pane_id === t || a.name === t);
  const [group, cmd, ...rest] = args;

  if (group === "agent" && cmd === "list") return ok({ agents: s.agents });
  if (group === "agent" && cmd === "get") {
    const a = find(rest[0]);
    return a ? ok({ agent: a }) : fail("agent_not_found");
  }
  if (group === "agent" && cmd === "prompt") {
    const a = find(rest[0]);
    if (!a) return fail("agent_not_found");
    if (a.agent_status === "blocked") return fail("agent_blocked");
    if (s.exitOnPrompt !== false && /^\/(exit|quit)$/.test(rest[1])) {
      s.agents = s.agents.filter((x) => x !== a);
    }
    return ok({ type: "agent_prompted" });
  }
  if (group === "agent" && cmd === "start") {
    const name = rest[0];
    const pane = rest[rest.indexOf("--pane") + 1];
    const kind = rest[rest.indexOf("--kind") + 1];
    if (find(pane)) return fail("pane_not_available");
    if (s.start === "fail") return fail("pane_not_available");
    const agent = { pane_id: pane, name, agent: kind, agent_status: s.start === "not_ready" ? "blocked" : "idle", focused: true, agent_session: null };
    s.agents.push(agent);
    return s.start === "not_ready" ? fail("agent_not_ready") : ok({ agent });
  }
  if (group === "pane" && cmd === "process-info") {
    const pane = rest[rest.indexOf("--pane") + 1];
    const a = find(pane);
    const procs = a && a.pid ? [{ name: a.agent, pid: a.pid, argv: [`/usr/bin/${a.agent}`] }] : [];
    return ok({ process_info: { pane_id: pane, shell_pid: 1, foreground_process_group_id: a?.pid || 1, foreground_processes: procs } });
  }
  if (group === "pane" && cmd === "list") return ok({ panes: s.panes || [] });
  return fail("unsupported_fake_call");
});

// Like the real CLI: results on stdout, error JSON on stderr.
(res.code === 0 ? process.stdout : process.stderr).write(JSON.stringify(res.out) + "\n");
process.exit(res.code);
