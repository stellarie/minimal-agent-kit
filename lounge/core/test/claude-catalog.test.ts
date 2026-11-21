import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readClaudeCatalog } from "../../plugins/claude-code/catalog.ts";
import { tempHome } from "./helpers.ts";

function model(id: string, section: string, efforts?: string[]): unknown {
  return {
    id,
    name: `Name ${id}`,
    section,
    runtime: efforts === undefined ? {} : { effort_levels: efforts, default_effort: efforts[0] },
  };
}

function catalogFile(fetchedAt: number, models: unknown[], aliases: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: 2,
    fetchedAt,
    catalog: { config: { models, provider_alias_targets: aliases } },
  });
}

function configDir(t: { after(fn: () => void): void }): { dir: string; folder: string } {
  const h = tempHome();
  t.after(() => h.cleanup());
  const folder = join(h.dir, "cache", "model-catalog");
  mkdirSync(folder, { recursive: true });
  return { dir: h.dir, folder };
}

test("c1_1: the newest -cc catalog gives its model ids and per-model effort_levels", (t) => {
  const { dir, folder } = configDir(t);
  writeFileSync(join(folder, "a-cc.json"), catalogFile(100, [model("old-model", "main", ["low"])]));
  writeFileSync(
    join(folder, "b-cc.json"),
    catalogFile(
      200,
      [
        model("big-overflow", "overflow", ["low", "high"]),
        model("big-main", "main", ["low", "medium", "high", "xhigh", "max"]),
        model("no-effort", "main"),
      ],
      { opus: { default: "big-main" }, haiku: { default: "no-effort" } },
    ),
  );
  writeFileSync(join(folder, "c-ccd.json"), catalogFile(300, [model("wrong-surface", "main", ["low"])]));
  const got = readClaudeCatalog(dir);
  assert.deepEqual(
    got.models.map((m) => [m.id, m.label, m.efforts]),
    [
      ["big-main", "Name big-main", ["low", "medium", "high", "xhigh", "max"]],
      ["no-effort", "Name no-effort", []],
      ["big-overflow", "Name big-overflow", ["low", "high"]],
    ],
  );
  assert.deepEqual(got.aliases, { opus: "big-main", haiku: "no-effort" });
  assert.equal(got.fetchedAt, 200);
});

test("c1_1: masked ids are left out", (t) => {
  const { dir, folder } = configDir(t);
  writeFileSync(join(folder, "a-cc.json"), catalogFile(1, [model("keep", "main", ["low"]), model("hidden", "overflow", ["low"])]));
  writeFileSync(join(folder, "masked-ids.json"), JSON.stringify({ version: 1, ids: ["hidden"] }));
  assert.deepEqual(readClaudeCatalog(dir).models.map((m) => m.id), ["keep"]);
  writeFileSync(join(folder, "masked-ids.json"), "not json");
  assert.deepEqual(readClaudeCatalog(dir).models.map((m) => m.id), ["keep", "hidden"]);
});

test("c1_1: no catalog folder gives an empty catalog", (t) => {
  const h = tempHome();
  t.after(() => h.cleanup());
  assert.deepEqual(readClaudeCatalog(h.dir), { models: [], aliases: {}, fetchedAt: 0 });
});

test("c1_1: an unreadable catalog file is skipped", (t) => {
  const { dir, folder } = configDir(t);
  writeFileSync(join(folder, "a-cc.json"), "{ nope");
  writeFileSync(join(folder, "b-cc.json"), JSON.stringify({ version: 2, fetchedAt: 9, catalog: { config: {} } }));
  assert.deepEqual(readClaudeCatalog(dir), { models: [], aliases: {}, fetchedAt: 0 });
  writeFileSync(join(folder, "c-cc.json"), catalogFile(5, [model("ok", "main", ["low"])]));
  assert.deepEqual(readClaudeCatalog(dir).models.map((m) => m.id), ["ok"]);
});
