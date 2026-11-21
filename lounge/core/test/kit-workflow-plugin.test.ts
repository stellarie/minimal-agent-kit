import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { openDb } from "../src/db/db.ts";
import { writeSetting } from "../src/db/settings.ts";
import { Plugins } from "../src/plugins/plugins.ts";
import { Skills } from "../src/skills/skills.ts";
import { tempHome } from "./helpers.ts";

const KIT = resolve(import.meta.dirname, "..", "..", "..", "claude");

async function load(t: TestContext): Promise<{ plugins: Plugins; skills: Skills }> {
  const h = tempHome();
  const db = openDb(join(h.dir, "lounge.db"));
  t.after(() => {
    db.close();
    h.cleanup();
  });
  writeSetting(db, "plugins.enabled", JSON.stringify(["kit-workflow"]));
  const plugins = new Plugins({ home: h.dir, db, log: () => {} });
  await plugins.load();
  return { plugins, skills: new Skills({ home: h.dir, extra: () => plugins.skillSources() }) };
}

test("c8_1: with Python 3 the kit-workflow plugin adds the workflow skill with $VERIFY set", async (t) => {
  const { plugins, skills } = await load(t);
  const info = plugins.list().find((p) => p.id === "kit-workflow")!;
  assert.deepEqual([info.bundled, info.enabled, info.error, info.skills], [true, true, undefined, ["workflow"]]);
  assert.deepEqual(skills.index().map((s) => s.name), ["workflow"]);
  const body = skills.body("workflow");
  const verify = join(KIT, "verify").replace(/\\/g, "/");
  assert.ok(body.includes(`${verify}/plan.schema.md`), "the body names the verify folder");
  assert.ok(!body.includes("$VERIFY"));
  assert.ok(existsSync(join(KIT, "verify", "verify_plan.py")));
  assert.ok(body.trimEnd().endsWith(`Skill files: ${join(KIT, "skills", "workflow").replace(/\\/g, "/")}`));
});

test("c8_1: without Python 3 the plugin fails with a clear error and adds no skill", async (t) => {
  const path = process.env.PATH;
  const win = process.env.Path;
  process.env.PATH = "";
  if (win !== undefined) process.env.Path = "";
  t.after(() => {
    if (path === undefined) delete process.env.PATH;
    else process.env.PATH = path;
    if (win !== undefined) process.env.Path = win;
  });
  const { plugins, skills } = await load(t);
  const info = plugins.list().find((p) => p.id === "kit-workflow")!;
  assert.match(info.error ?? "", /kit workflow needs Python 3 on the PATH/);
  assert.deepEqual(plugins.skillSources(), []);
  assert.deepEqual(skills.index(), []);
});
