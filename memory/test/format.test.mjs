import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Store } from "../src/store.mjs";
import { DEFAULTS } from "../src/decay.mjs";
import { TOOLS } from "../src/commands.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const AMEM = path.join(here, "..", "bin", "amem.mjs");
const MCP = path.join(here, "..", "bin", "mcp.mjs");

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "amem-f-"));
}

const FEEDBACK =
  "Use tabs.\nWhy: the formatter is configured for tabs.\nHow to apply: never convert tabs to spaces.";

test("remember rejects a missing or unknown type", () => {
  const store = new Store({ root: tempRoot(), agent: "a" });
  assert.throws(
    () => store.remember({ title: "t", body: "b" }),
    /needs a type: one of user, feedback, project, reference/,
  );
  assert.throws(() => store.remember({ title: "t", type: "note", body: "b" }), /needs a type/);
  assert.equal(store.listMemories().length, 0);
});

test("feedback and project bodies need a Why line and a How to apply line", () => {
  const store = new Store({ root: tempRoot(), agent: "a" });
  for (const type of ["feedback", "project"]) {
    assert.throws(() => store.remember({ title: "t", type, body: "plain" }), /"Why:" and "How to apply:"/);
    assert.throws(() => store.remember({ title: "t", type, body: "Why: a" }), /"How to apply:"/);
    assert.throws(() => store.remember({ title: "t", type, body: "How to apply: a" }), /"Why:"/);
    assert.throws(() => store.remember({ title: "t", type, body: "Why:\nHow to apply: a" }), /"Why:"/);
    assert.throws(
      () => store.remember({ title: "t", type, body: "see Why: here\nHow to apply: a" }),
      /"Why:"/,
    );
    assert.equal(store.remember({ title: `ok ${type}`, type, body: FEEDBACK }).type, type);
  }
  assert.equal(store.listMemories().length, 2);
});

test("user and reference bodies are free text, and type is stored in the file", () => {
  const store = new Store({ root: tempRoot(), agent: "a" });
  const user = store.remember({ title: "Stella is a senior SWE", type: "User", body: "Prefers short answers." });
  const ref = store.remember({ title: "Runbook lives in Notion", type: "reference", body: "Page: Ops runbook" });
  assert.equal(store.readMemory(user.id).type, "user");
  assert.equal(store.readMemory(ref.id).type, "reference");
  const text = fs.readFileSync(path.join(store.memoriesDir, `${ref.id}.md`), "utf8");
  assert.match(text, /\ntitle: Runbook lives in Notion\ntype: reference\n/);
});

test("a legacy memory without type still reads, indexes, and searches", () => {
  const root = tempRoot();
  fs.mkdirSync(path.join(root, "memories"));
  fs.writeFileSync(
    path.join(root, "memories", "old-1.md"),
    "---\nid: old-1\ntitle: Legacy okapi note\ntags: zoo\nauthor: a\n---\n\nthe body\n",
  );
  const store = new Store({ root, agent: "a" });
  assert.equal(store.readMemory("old-1").type, "");
  const hit = store.search({ query: "okapi" })[0];
  assert.equal(hit.id, "old-1");
  assert.equal(hit.type, "");
  assert.equal(store.recall("old-1").memory.body, "the body");
  store.setPinned("old-1", true);
  assert.match(store.index(), /- \[old-1\] Legacy okapi note - the body/);
});

test("index and search lines show the type", () => {
  const store = new Store({ root: tempRoot(), agent: "a" });
  const m = store.remember({ title: "Tabs not spaces", type: "feedback", body: FEEDBACK });
  assert.match(store.index(), new RegExp(`- \\[${m.id}\\] \\(feedback\\) Tabs not spaces - Use tabs\\.`));
  const run = (args) =>
    spawnSync(process.execPath, [AMEM, ...args], {
      env: { ...process.env, AGENT_MEMORY_HOME: store.root, AGENT_MEMORY_AGENT: "a" },
      encoding: "utf8",
    });
  assert.match(run(["search", "tabs"]).stdout, new RegExp(`- \\[${m.id}\\] \\(feedback\\) Tabs not spaces`));
  assert.match(run(["recall", m.id]).stdout, /type: feedback/);
});

test("CLI remember takes --type and rejects a missing or bad one", () => {
  const root = tempRoot();
  const run = (args) =>
    spawnSync(process.execPath, [AMEM, "remember", ...args], {
      env: { ...process.env, AGENT_MEMORY_HOME: root, AGENT_MEMORY_AGENT: "a" },
      encoding: "utf8",
    });
  assert.equal(run(["--title", "x", "--body", "y"]).status, 2);
  const bad = run(["--title", "x", "--type", "feedback", "--body", "y"]);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /Why:/);
  assert.equal(run(["--title", "x", "--type", "project", "--body", FEEDBACK]).status, 0);
});

test("MCP memory_remember schema requires a type enum and enforces it", async () => {
  const tool = TOOLS.find((t) => t.name === "memory_remember");
  assert.deepEqual(tool.inputSchema.properties.type.enum, ["user", "feedback", "project", "reference"]);
  assert.ok(tool.inputSchema.required.includes("type"));

  const root = tempRoot();
  const child = spawn(process.execPath, [MCP], {
    env: { ...process.env, AGENT_MEMORY_HOME: root, AGENT_MEMORY_AGENT: "a" },
  });
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
  const call = (id, args) =>
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "memory_remember", arguments: args } })}\n`,
    );
  call(1, { title: "no type", body: "b" });
  call(2, { title: "bad body", type: "feedback", body: "b" });
  call(3, { title: "good", type: "feedback", body: FEEDBACK, author: "spoof" });
  const deadline = Date.now() + 5000;
  while (responses.length < 3 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
  child.kill();
  const byId = Object.fromEntries(responses.map((r) => [r.id, r.result]));
  assert.equal(byId[1].isError, true);
  assert.equal(byId[2].isError, true);
  assert.match(byId[3].content[0].text, /^Remembered \[/);
  const store = new Store({ root, agent: "a" });
  assert.equal(store.listMemories()[0].author, "a", "a client cannot set the author");
});

test("the default budget is 100", () => {
  assert.equal(DEFAULTS.budget, 100);
  const root = tempRoot();
  const store = new Store({ root, agent: "a" });
  assert.equal(store.config.budget, 100);
  for (let i = 0; i < 40; i++) store.remember({ title: `fact ${i}`, type: "reference", body: "b" });
  assert.equal(store.index().split("\n").filter((l) => l.startsWith("- [")).length, 40);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ budget: 5 }));
  assert.equal(new Store({ root, agent: "a" }).config.budget, 5);
});

test("an unknown type survives pin, unpin, and invalidate", () => {
  const root = tempRoot();
  fs.mkdirSync(path.join(root, "memories"));
  const file = path.join(root, "memories", "odd-1.md");
  fs.writeFileSync(file, "---\nid: odd-1\ntitle: Odd note\ntype: note\n---\n\nbody\n");
  const store = new Store({ root, agent: "a" });
  assert.equal(store.readMemory("odd-1").type, "", "unknown type shows no label");
  store.setPinned("odd-1", true);
  store.setPinned("odd-1", false);
  assert.match(fs.readFileSync(file, "utf8"), /\ntype: note\n/);
  store.invalidate("odd-1", "wrong");
  assert.match(fs.readFileSync(file, "utf8"), /\ntype: note\n/);
  assert.match(fs.readFileSync(file, "utf8"), /\nvalid: false\n/);
});
