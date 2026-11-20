import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startCore } from "../src/api/http.ts";
import { seedSkills } from "../src/skills/seed.ts";
import { Skills } from "../src/skills/skills.ts";
import { tempHome } from "./helpers.ts";

const SEEDS = ["lounge-workflow", "ste", "wiki"];

function bundle(root: string): string {
  const dir = join(root, "bundle");
  for (const name of SEEDS) {
    mkdirSync(join(dir, name), { recursive: true });
    writeFileSync(join(dir, name, "SKILL.md"), `---\nname: ${name}\ndescription: "Seed ${name}."\n---\n\nSeed text of ${name}.\n`);
  }
  return dir;
}

test("c12_1: a first start copies each seed folder into <home>/skills", (t) => {
  const home = tempHome();
  t.after(home.cleanup);
  const store = new Skills({ home: home.dir });
  assert.deepEqual(seedSkills(store, bundle(home.dir)).sort(), SEEDS);
  assert.deepEqual(store.index().map((s) => s.name), SEEDS);
  assert.match(readFileSync(join(store.root, "ste", "SKILL.md"), "utf8"), /Seed text of ste/);
});

test("c12_1: an existing folder is never overwritten, even a broken one", (t) => {
  const home = tempHome();
  t.after(home.cleanup);
  const store = new Skills({ home: home.dir });
  mkdirSync(join(store.root, "wiki"), { recursive: true });
  writeFileSync(join(store.root, "wiki", "SKILL.md"), "not a skill");
  assert.deepEqual(seedSkills(store, bundle(home.dir)).sort(), ["lounge-workflow", "ste"]);
  assert.equal(readFileSync(join(store.root, "wiki", "SKILL.md"), "utf8"), "not a skill");
});

test("c12_1: a missing bundle folder seeds nothing", (t) => {
  const home = tempHome();
  t.after(home.cleanup);
  const store = new Skills({ home: home.dir });
  assert.deepEqual(seedSkills(store, join(home.dir, "nowhere")), []);
  assert.equal(existsSync(store.root), false);
});

test("c12_1: the bundled lounge skills are valid, and the workflow names the lounge tools", (t) => {
  const home = tempHome();
  t.after(home.cleanup);
  const store = new Skills({ home: home.dir });
  assert.deepEqual(seedSkills(store).sort(), SEEDS);
  const scan = store.scan();
  assert.deepEqual(scan.skipped, []);
  assert.deepEqual(scan.skills.map((s) => s.name), SEEDS);
  const flow = store.body("lounge-workflow");
  for (const tool of ["lounge_gate", "lounge_spawn", "lounge_skill"]) assert.match(flow, new RegExp(tool));
});

test("SC22: an edited <home>/skills/ste stays when the lounge starts again", async (t) => {
  const home = tempHome();
  const bundled = bundle(home.dir);
  const start = async () => startCore({ home: home.dir, port: 0, schedule: false, bundledSkills: bundled });
  const running: { close(): Promise<void> }[] = [];
  t.after(async () => {
    for (const core of running) await core.close();
    home.cleanup();
  });
  const first = await start();
  running.push(first);
  const file = join(home.dir, "skills", "ste", "SKILL.md");
  assert.match(readFileSync(file, "utf8"), /Seed text of ste/);
  const edited = "---\nname: ste\ndescription: \"Mine.\"\n---\n\nMy own rules.\n";
  writeFileSync(file, edited);
  await first.close();
  running.length = 0;
  const second = await start();
  running.push(second);
  assert.equal(readFileSync(file, "utf8"), edited);
});
