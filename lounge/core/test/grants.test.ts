import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { Grants, denyAll } from "../src/auth/grants.ts";
import { openDb } from "../src/db/db.ts";
import { tempHome, testRoster } from "./helpers.ts";

function grants(t: { after(fn: () => void): void }): Grants {
  const home = tempHome();
  const db = openDb(join(home.dir, "lounge.db"));
  t.after(() => {
    db.close();
    home.cleanup();
  });
  return new Grants(db);
}

test("every group is on by default", (t) => {
  const g = grants(t);
  assert.ok(Object.values(g.get("ada")).every((on) => on));
  assert.ok(g.allows("ada", "lounge_nick"));
  assert.ok(g.runtimeTools("ada").includes("mcp__lounge__lounge_nick"));
});

test("a group turned off blocks its actions and leaves the runtime list", (t) => {
  const g = grants(t);
  g.set("cyd", { nick: false, threads: false });
  assert.equal(g.allows("cyd", "lounge_nick"), false);
  assert.equal(g.allows("cyd", "thread_start"), false);
  assert.ok(g.allows("cyd", "lounge_post"));
  assert.ok(g.allows("ada", "lounge_nick"));
  const tools = g.runtimeTools("cyd");
  assert.ok(!tools.includes("mcp__lounge__lounge_nick"));
  assert.ok(tools.includes("mcp__lounge__lounge_post"));
});

test("set refuses unknown groups and values that are not true or false", (t) => {
  const g = grants(t);
  assert.throws(() => g.set("ada", { fly: true }), /unknown group/);
  assert.throws(() => g.set("ada", { nick: "yes" }), /true or false/);
  assert.throws(() => g.set("ada", []), /object/);
  assert.ok(g.allows("ada", "lounge_nick"));
});

test("a new agent has no tool grants", (t) => {
  const home = tempHome();
  const db = openDb(join(home.dir, "lounge.db"));
  t.after(() => {
    db.close();
    home.cleanup();
  });
  const roster = testRoster(db);
  roster.add({ id: "nana", runtime: "stub" });
  const g = new Grants(db);
  assert.deepEqual(g.runtimeTools("nana"), []);
  assert.equal(g.pcAccess("nana"), false);
  assert.ok(Object.values(g.get("nana")).every((on) => !on));
  assert.ok(g.runtimeTools("ada").length > 0, "a seed agent keeps her grants");
});

test("a group closed for one agent stays closed for a plugin group added later", (t) => {
  const home = tempHome();
  const db = openDb(join(home.dir, "lounge.db"));
  t.after(() => {
    db.close();
    home.cleanup();
  });
  const plugin = { id: "plugin.later", label: "Later", tools: ["later_tool"] };
  let extra: (typeof plugin)[] = [];
  const g = new Grants(db, () => extra);
  denyAll(db, "nana", g.groups().map((x) => x.id));
  extra = [plugin];
  assert.equal(g.get("nana")["plugin.later"], false);
  assert.equal(g.get("ada")["plugin.later"], true);
  g.set("nana", { chat: true });
  assert.equal(g.get("nana")["plugin.later"], false, "set keeps the closed default");
  assert.equal(g.get("nana").chat, true);
});

test("the web group adds the runtime search tools, and off removes them", (t) => {
  const g = grants(t);
  assert.ok(g.runtimeTools("ada").includes("WebSearch"));
  assert.ok(g.runtimeTools("ada").includes("WebFetch"));
  g.set("ada", { web: false });
  assert.ok(!g.runtimeTools("ada").some((x) => x.startsWith("Web")));
});
