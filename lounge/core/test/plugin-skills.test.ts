import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { startCore } from "../src/api/http.ts";
import { ensureTokens } from "../src/auth/tokens.ts";
import { openDb } from "../src/db/db.ts";
import { writeSetting } from "../src/db/settings.ts";
import { Plugins, type PluginInfo } from "../src/plugins/plugins.ts";
import { Skills } from "../src/skills/skills.ts";
import { SEED_CALLERS, tempHome } from "./helpers.ts";

const SKILL = (name: string, body: string) => `---\nname: ${name}\ndescription: "The ${name} skill."\n---\n\n${body}\n`;

interface Rig {
  home: string;
  bundled: string;
  shared: string;
  plugins: Plugins;
  skills: Skills;
}

function folder(...parts: string[]): string {
  const dir = join(...parts);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function manifest(dir: string, body: object): void {
  writeFileSync(join(dir, "plugin.json"), JSON.stringify(body));
}

async function rig(t: TestContext, enabled: string[] = ["kit"]): Promise<Rig> {
  const h = tempHome();
  const bundled = folder(h.dir, "bundled");
  const shared = folder(h.dir, "shared");
  folder(shared, "workflow");
  writeFileSync(join(shared, "workflow", "SKILL.md"), SKILL("workflow", "Run $VERIFY/check.py now."));
  folder(shared, "verify");
  manifest(folder(bundled, "kit"), {
    name: "Kit",
    skills: { workflow: "../../shared/workflow" },
    vars: { VERIFY: "../../shared/verify" },
  });
  const db = openDb(join(h.dir, "lounge.db"));
  t.after(() => {
    db.close();
    h.cleanup();
  });
  writeSetting(db, "plugins.enabled", JSON.stringify(enabled));
  const plugins = new Plugins({ home: h.dir, db, bundledDir: bundled, log: () => {} });
  await plugins.load();
  const skills = new Skills({ home: h.dir, extra: () => plugins.skillSources() });
  return { home: h.dir, bundled, shared, plugins, skills };
}

test("c7_1: an enabled plugin's skills field adds read-only skills", async (t) => {
  const r = await rig(t);
  const want = resolve(r.shared, "workflow");
  assert.deepEqual(r.plugins.skillSources(), [
    { name: "workflow", dir: want, vars: { VERIFY: resolve(r.shared, "verify") } },
  ]);
  assert.deepEqual(r.skills.index(), [{ name: "workflow", description: "The workflow skill." }]);
  assert.throws(() => r.skills.get("workflow"), /unknown skill/);
  assert.throws(() => r.skills.replace("workflow", SKILL("workflow", "x")), /unknown skill/);
  assert.throws(() => r.skills.remove("workflow"), /unknown skill/);
  const info = r.plugins.list().find((p) => p.id === "kit")!;
  assert.deepEqual([info.error, info.skills], [undefined, ["workflow"]]);
});

test("c7_1: a disabled plugin adds no skills", async (t) => {
  const r = await rig(t, []);
  assert.deepEqual(r.plugins.skillSources(), []);
  assert.deepEqual(r.skills.index(), []);
  assert.deepEqual(r.plugins.list().find((p) => p.id === "kit")!.skills, ["workflow"]);
});

test("c7_1: a home plugin skill path outside its folder is an error", async (t) => {
  const r = await rig(t, ["mine"]);
  const mine = folder(r.home, "plugins", "mine");
  manifest(mine, { name: "Mine", skills: { workflow: "../../shared/workflow" } });
  await r.plugins.load();
  assert.deepEqual(r.plugins.skillSources(), []);
  assert.match(r.plugins.list().find((p) => p.id === "mine")!.error ?? "", /skills workflow must stay inside the plugin folder/);
  manifest(mine, { name: "Mine", vars: { VERIFY: "../verify" } });
  await r.plugins.load();
  assert.match(r.plugins.list().find((p) => p.id === "mine")!.error ?? "", /vars VERIFY must stay inside the plugin folder/);
  manifest(mine, { name: "Mine", skills: { "Bad Name": "skill" } });
  await r.plugins.load();
  assert.match(r.plugins.list().find((p) => p.id === "mine")!.error ?? "", /skill name/);
});

test("c7_1: a home skill of the same name wins over a plugin skill", async (t) => {
  const r = await rig(t);
  folder(r.home, "skills", "workflow");
  writeFileSync(join(r.home, "skills", "workflow", "SKILL.md"), SKILL("workflow", "Home body."));
  assert.equal(r.skills.scan().skills.length, 1);
  assert.equal(r.skills.body("workflow").trim(), "Home body.");
  assert.equal(r.skills.get("workflow").text.includes("Home body."), true);
});

test("c7_2: body replaces $VERIFY with the absolute vars path", async (t) => {
  const r = await rig(t);
  const verify = resolve(r.shared, "verify").replace(/\\/g, "/");
  assert.match(r.skills.body("workflow"), new RegExp(`^Run ${verify.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/check\\.py now\\.`));
  assert.ok(!r.skills.body("workflow").includes("$VERIFY"));
});

test("c7_2: body ends with the absolute folder of the skill files", async (t) => {
  const r = await rig(t);
  const dir = resolve(r.shared, "workflow").replace(/\\/g, "/");
  assert.ok(r.skills.body("workflow").trimEnd().endsWith(`Skill files: ${dir}`));
});

test("c7_1: the core lists an enabled bundled plugin skill in the skills API", async (t) => {
  const h = tempHome();
  const bundled = folder(h.dir, "bundled");
  folder(h.dir, "pack", "workflow");
  writeFileSync(join(h.dir, "pack", "workflow", "SKILL.md"), SKILL("workflow", "Body."));
  manifest(folder(bundled, "kit"), { name: "Kit", skills: { workflow: "../../pack/workflow" } });
  const core = await startCore({ home: h.dir, port: 0, schedule: false, bundledPlugins: bundled });
  t.after(async () => {
    await core.close();
    h.cleanup();
  });
  const tokens = ensureTokens(h.dir, SEED_CALLERS);
  const call = (path: string, init: RequestInit = {}) =>
    fetch(core.url + path, { ...init, headers: { "content-type": "application/json", authorization: `Bearer ${tokens.owner!}` } });
  const list = async () => ((await (await call("/api/skills")).json()) as { skills: { name: string }[] }).skills.map((s) => s.name);
  assert.deepEqual(await list(), []);
  const put = await call("/api/plugins/kit", { method: "PUT", body: JSON.stringify({ enabled: true }) });
  assert.deepEqual(((await put.json()) as { plugins: PluginInfo[] }).plugins.find((p) => p.id === "kit")!.skills, ["workflow"]);
  assert.deepEqual(await list(), ["workflow"]);
});
