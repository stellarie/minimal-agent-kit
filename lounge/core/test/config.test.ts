import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { chatFolder, loadConfig, loungeHome } from "../src/config.ts";
import { tempHome } from "./helpers.ts";

test("loadConfig on empty home writes defaults", (t) => {
  const home = tempHome();
  t.after(home.cleanup);
  const config = loadConfig(home.dir);
  assert.equal(config.port, 47621);
  assert.equal(config.host, "127.0.0.1");
  assert.equal(config.adapters.bea.enabled, false);
  assert.equal(config.adapters.ada.enabled, true);
  assert.equal(config.adapters.cyd.enabled, true);
  assert.equal(config.adapters.dee.enabled, false);
  const file = join(home.dir, "config.json");
  assert.ok(existsSync(file));
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), config);
});

test("loadConfig keeps values from an existing file", (t) => {
  const home = tempHome();
  t.after(home.cleanup);
  loadConfig(home.dir);
  const file = join(home.dir, "config.json");
  const saved = JSON.parse(readFileSync(file, "utf8"));
  saved.port = 50000;
  saved.adapters.dee.enabled = true;
  writeFileSync(file, JSON.stringify(saved));
  const config = loadConfig(home.dir);
  assert.equal(config.port, 50000);
  assert.equal(config.adapters.dee.enabled, true);
  assert.equal(config.adapters.ada.enabled, true);
});

test("loungeHome honors AGENT_LOUNGE_HOME", () => {
  assert.equal(loungeHome({ AGENT_LOUNGE_HOME: "X:/lounge-here" }), "X:/lounge-here");
  assert.match(loungeHome({}), /\.agent-lounge$/);
});

test("loadConfig defaults sessions and the grant table", (t) => {
  const home = tempHome();
  t.after(home.cleanup);
  const config = loadConfig(home.dir);
  assert.deepEqual(config.sessions, {
    maxRunning: 3,
    queueTimeoutMs: 1_800_000,
    replyWaitMs: 20_000,
    contextMessages: 40,
  });
  assert.deepEqual(config.permissions.ada, { chat: "start", work: "queue" });
  assert.deepEqual(config.permissions.dee, { chat: "reject", work: "reject" });
  assert.equal(config.adapters.ada.command, "claude");
  assert.equal(config.adapters.ada.hardMs, 180_000);
});

test("loadConfig keeps adapter and session overrides", (t) => {
  const home = tempHome();
  t.after(home.cleanup);
  writeFileSync(
    join(home.dir, "config.json"),
    JSON.stringify({
      adapters: { ada: { command: "node", commandArgs: ["cli.js"], softMs: 5 } },
      sessions: { maxRunning: 1 },
      permissions: { bea: { chat: "start" } },
    }),
  );
  const config = loadConfig(home.dir);
  assert.equal(config.adapters.ada.command, "node");
  assert.deepEqual(config.adapters.ada.commandArgs, ["cli.js"]);
  assert.equal(config.adapters.ada.softMs, 5);
  assert.equal(config.adapters.ada.hardMs, 180_000);
  assert.equal(config.adapters.ada.enabled, true);
  assert.equal(config.sessions.maxRunning, 1);
  assert.equal(config.sessions.replyWaitMs, 20_000);
  assert.deepEqual(config.permissions.bea, { chat: "start", work: "reject" });
});

test("loadConfig rejects invalid session fields", (t) => {
  const home = tempHome();
  t.after(home.cleanup);
  const file = join(home.dir, "config.json");
  const cases: [unknown, RegExp][] = [
    [{ permissions: { ada: { chat: "queue" } } }, /invalid permissions\.ada\.chat/],
    [{ permissions: { cyd: { work: "maybe" } } }, /invalid permissions\.cyd\.work/],
    [{ sessions: { maxRunning: 0 } }, /invalid sessions\.maxRunning/],
    [{ adapters: { ada: { commandArgs: "x" } } }, /invalid adapters\.ada\.commandArgs/],
    [{ adapters: { ada: { hardMs: -1 } } }, /invalid adapters\.ada\.hardMs/],
    [{ adapters: { ada: { command: "" } } }, /invalid adapters\.ada\.command/],
  ];
  for (const [raw, pattern] of cases) {
    writeFileSync(file, JSON.stringify(raw));
    assert.throws(() => loadConfig(home.dir), pattern);
  }
});

test("the chat folder is a sibling of the lounge home, with no agent in its name", () => {
  const home = join("C:", "Users", "Dev", ".agent-lounge");
  const folder = chatFolder(home, "ada");
  assert.equal(folder, join("C:", "Users", "Dev", ".lounge-chat", "ada"));
  assert.ok(!folder.startsWith(home), folder);
  assert.doesNotMatch(dirname(folder), /agent|~\d/i);
  assert.equal(chatFolder(join("D:", "data", "lounge"), "cyd"), join("D:", "data", "lounge-chat", "cyd"));
});

test("a lounge home at a drive root or named agent still gets a chat folder outside it", () => {
  const root = join("D:", "/");
  assert.ok(!chatFolder(root, "cyd").startsWith(root), chatFolder(root, "cyd"));
  assert.equal(chatFolder(join("C:", "x", "agent"), "cyd"), join("C:", "x", "lounge-chat", "cyd"));
});
