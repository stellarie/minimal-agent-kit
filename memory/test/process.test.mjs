import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(here, "..", "bin");
const AMEM = path.join(BIN, "amem.mjs");
const MCP = path.join(BIN, "mcp.mjs");

function env(root, agent = "t") {
  return { ...process.env, AGENT_MEMORY_HOME: root, AGENT_MEMORY_AGENT: agent };
}

function amem(root, args, input) {
  return spawnSync(process.execPath, [AMEM, ...args], { env: env(root), input, encoding: "utf8" });
}

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "amem-p-"));
}

test("session-start advances the clock except on resume and compact", () => {
  const root = tempRoot();
  const session = () =>
    JSON.parse(fs.readFileSync(path.join(root, "state", "t.json"), "utf8")).session;
  let out = amem(root, ["session-start"], JSON.stringify({ source: "startup" }));
  assert.equal(out.status, 0);
  assert.match(out.stdout, /# Memory index \(agent: t, session 1\)/);
  amem(root, ["session-start"], JSON.stringify({ source: "resume" }));
  amem(root, ["session-start"], JSON.stringify({ source: "compact" }));
  assert.equal(session(), 1);
  amem(root, ["session-start"], "");
  assert.equal(session(), 2);
});

test("session-start never fails the session", () => {
  const root = tempRoot();
  fs.mkdirSync(path.join(root, "state"));
  fs.writeFileSync(path.join(root, "state", "t.json"), "{broken");
  const out = amem(root, ["session-start"], "");
  assert.equal(out.status, 0);
  assert.match(out.stdout, /Memory index unavailable/);
});

test("CLI round trip: remember, search, recall", () => {
  const root = tempRoot();
  const made = amem(root, ["remember", "--type", "reference", "--title", "Use pnpm here", "--body", "npm breaks the lockfile", "--tags", "node,pkg"]);
  assert.equal(made.status, 0, made.stderr);
  const id = /\[([a-z0-9-]+)\]/.exec(made.stdout)[1];
  const found = amem(root, ["search", "pnpm", "lockfile"]);
  assert.match(found.stdout, new RegExp(id));
  const recalled = amem(root, ["recall", id]);
  assert.match(recalled.stdout, /npm breaks the lockfile/);
  const missing = amem(root, ["remember", "--title", "x"]);
  assert.equal(missing.status, 2);
});

test("MCP server answers initialize, tools/list, and tools/call", async () => {
  const root = tempRoot();
  const child = spawn(process.execPath, [MCP], { env: env(root) });
  const responses = [];
  let buffer = "";
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      responses.push(JSON.parse(buffer.slice(0, nl)));
      buffer = buffer.slice(nl + 1);
    }
  });
  const sendLine = (msg) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...msg })}\n`);
  sendLine({ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } });
  sendLine({ method: "notifications/initialized" });
  sendLine({ id: 2, method: "tools/list" });
  sendLine({ id: 3, method: "tools/call", params: { name: "memory_remember", arguments: { title: "mcp fact", type: "reference", body: "from mcp" } } });
  sendLine({ id: 4, method: "tools/call", params: { name: "memory_recall", arguments: { id: "../nope" } } });
  sendLine({ id: 5, method: "nope" });
  child.stdin.write("not json\n");

  const deadline = Date.now() + 5000;
  while (responses.length < 6 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
  child.kill();

  const byId = Object.fromEntries(responses.map((r) => [r.id, r]));
  assert.equal(responses.length, 6, JSON.stringify(responses));
  assert.ok(responses.every((r) => r.jsonrpc === "2.0"));
  assert.equal(byId[1].result.protocolVersion, "2025-06-18");
  assert.ok(byId[1].result.capabilities.tools);
  const names = byId[2].result.tools.map((t) => t.name);
  assert.ok(names.includes("memory_search") && names.includes("memory_recall"));
  assert.ok(byId[2].result.tools.every((t) => t.inputSchema.type === "object"));
  assert.match(byId[3].result.content[0].text, /^Remembered \[/);
  assert.equal(byId[4].result.isError, true);
  assert.equal(byId[5].error.code, -32601);
  assert.equal(byId[null].error.code, -32700);
  assert.equal(fs.readdirSync(path.join(root, "memories")).length, 1);
});

test("parallel writers lose no memory or state entry", async () => {
  const root = tempRoot();
  const WORKERS = 6;
  const EACH = 25;
  const storeUrl = new URL("../src/store.mjs", import.meta.url).href;
  const script =
    `const { Store } = await import(${JSON.stringify(storeUrl)});` +
    `for (let i = 0; i < ${EACH}; i++) new Store().remember({ type: "reference", title: "w" + process.pid + " " + i, body: "b" });`;
  const runs = Array.from({ length: WORKERS }, () =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, ["--input-type=module", "-e", script], { env: env(root) });
      let err = "";
      child.stderr.on("data", (d) => (err += d));
      child.on("close", (code) => resolve({ code, err }));
    }),
  );
  const results = await Promise.all(runs);
  for (const r of results) assert.equal(r.code, 0, r.err);
  const total = WORKERS * EACH;
  assert.equal(fs.readdirSync(path.join(root, "memories")).filter((f) => f.endsWith(".md")).length, total);
  const state = JSON.parse(fs.readFileSync(path.join(root, "state", "t.json"), "utf8"));
  assert.equal(Object.keys(state.memories).length, total);
  assert.equal(fs.existsSync(path.join(root, ".lock")), false);
});

test("a broken config.json does not fail the hook", () => {
  const root = tempRoot();
  fs.writeFileSync(path.join(root, "config.json"), "{nope");
  const out = amem(root, ["session-start"], "");
  assert.equal(out.status, 0);
  assert.match(out.stdout, /Memory index unavailable/);
});

test("session-start does not hang on an open stdin pipe", async () => {
  const root = tempRoot();
  const child = spawn(process.execPath, [AMEM, "session-start"], { env: env(root) });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  const code = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill();
      resolve("timeout");
    }, 8000);
    child.on("close", (c) => {
      clearTimeout(timer);
      resolve(c);
    });
  });
  assert.equal(code, 0);
  assert.match(out, /# Memory index/);
});

test("CLI values may start with dashes, and a missing value fails", () => {
  const root = tempRoot();
  const made = amem(root, ["remember", "--type", "reference", "--title", "--force push is banned", "--body", "-- never on main"]);
  assert.equal(made.status, 0, made.stderr);
  const id = /\[([a-z0-9-]+)\]/.exec(made.stdout)[1];
  const recalled = amem(root, ["recall", id]);
  assert.match(recalled.stdout, /# --force push is banned/);
  assert.match(recalled.stdout, /-- never on main/);
  const bad = amem(root, ["invalidate", id, "--reason"]);
  assert.equal(bad.status, 2);
  assert.match(amem(root, ["recall", id]).stdout, /valid: true/);
});

test("agent name precedence: --agent, AGENT_MEMORY_AGENT, --runtime", () => {
  const root = tempRoot();
  const run = (args, agent) => {
    const e = { ...process.env, AGENT_MEMORY_HOME: root };
    for (const k of ["AGENT_MEMORY_AGENT", "AGENT_MEMORY_RUNTIME", "PLUGIN_ROOT", "CLAUDE_PLUGIN_ROOT", "CLAUDECODE"]) delete e[k];
    if (agent) e.AGENT_MEMORY_AGENT = agent;
    return spawnSync(process.execPath, [AMEM, "index", ...args], { env: e, encoding: "utf8" }).stdout;
  };
  assert.match(run([], undefined), /agent: default/);
  assert.match(run(["--runtime", "codex"], undefined), /agent: codex/);
  assert.match(run(["--runtime", "codex"], "agent-b"), /agent: agent-b/);
  assert.match(run(["--agent", "agent-c"], "agent-b"), /agent: agent-c/);
});

test("MCP server survives a null line and negotiates the version", () => {
  const root = tempRoot();
  const input = [
    "null",
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "1999-01-01" } }),
    JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" }),
    "",
  ].join("\n");
  const out = spawnSync(process.execPath, [MCP], { env: env(root), input, encoding: "utf8" });
  const lines = out.stdout.trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines.length, 3, out.stdout + out.stderr);
  assert.equal(lines[0].error.code, -32600);
  assert.equal(lines[1].result.protocolVersion, "2025-06-18");
  assert.deepEqual(lines[2].result, {});
});
