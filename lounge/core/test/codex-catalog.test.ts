import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readCodexCatalog } from "../../plugins/codex/catalog.ts";
import { tempHome } from "./helpers.ts";

function entry(slug: string, visibility: string, efforts: string[], fallback = "low"): unknown {
  return {
    slug,
    display_name: `Name ${slug}`,
    visibility,
    default_reasoning_level: fallback,
    supported_reasoning_levels: efforts.map((effort) => ({ effort, description: "x" })),
  };
}

const LISTED = JSON.stringify({
  models: [entry("m-one", "list", ["low", "high"], "high"), entry("m-two", "list", ["low", "medium", "ultra"])],
});

function rig(t: TestContext, script: string, cache?: string): { home: string; command: string; commandArgs: string[] } {
  const h = tempHome();
  t.after(() => h.cleanup());
  const file = join(h.dir, "fake-codex.mjs");
  writeFileSync(file, script);
  if (cache !== undefined) {
    mkdirSync(join(h.dir, "codex-home"), { recursive: true });
    writeFileSync(join(h.dir, "codex-home", "models_cache.json"), cache);
  }
  return { home: h.dir, command: process.execPath, commandArgs: [file] };
}

const prints = (json: string) => `process.stdout.write(${JSON.stringify(json)});`;
const fails = "process.stderr.write('boom'); process.exit(3);";

test("c2_1: debug models output gives listed slugs and their supported_reasoning_levels", async (t) => {
  const onlyDebugModels = `
const rest = process.argv.slice(2).join(" ");
if (!rest.endsWith("debug models") || !process.env.CODEX_HOME.endsWith("codex-home")) process.exit(3);
${prints(LISTED)}`;
  const r = rig(t, onlyDebugModels);
  const got = await readCodexCatalog(r);
  assert.deepEqual(got.models, [
    { id: "m-one", label: "Name m-one", efforts: ["low", "high"], default: "high" },
    { id: "m-two", label: "Name m-two", efforts: ["low", "medium", "ultra"], default: "low" },
  ]);
});

test("c2_1: a failed debug models run falls back to models_cache.json", async (t) => {
  const r = rig(t, fails, JSON.stringify({ fetched_at: "x", models: [entry("cached", "list", ["low", "max"])] }));
  const got = await readCodexCatalog(r);
  assert.deepEqual(got.models.map((m) => [m.id, m.efforts]), [["cached", ["low", "max"]]]);
});

test("c2_1: no cli and no cache give an empty catalog", async (t) => {
  const r = rig(t, fails);
  assert.deepEqual(await readCodexCatalog(r), { models: [] });
  const missing = await readCodexCatalog({ ...r, command: join(r.home, "no-such-codex") });
  assert.deepEqual(missing, { models: [] });
  const garbage = rig(t, prints("not json"), "also not json");
  assert.deepEqual(await readCodexCatalog(garbage), { models: [] });
});

test("c2_1: visibility hide models are left out", async (t) => {
  const mixed = JSON.stringify({
    models: [entry("shown", "list", ["low"]), entry("secret", "hide", ["low"]), entry("odd", "list", [])],
  });
  const r = rig(t, prints(mixed));
  assert.deepEqual((await readCodexCatalog(r)).models.map((m) => m.id), ["shown", "odd"]);
});
