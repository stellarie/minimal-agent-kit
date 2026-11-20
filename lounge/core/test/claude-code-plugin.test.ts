import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { startCore } from "../src/api/http.ts";
import { ensureTokens } from "../src/auth/tokens.ts";
import type { PluginInfo } from "../src/plugins/plugins.ts";
import { SEED_CALLERS, tempHome } from "./helpers.ts";

const PLUGINS = resolve(import.meta.dirname, "..", "..", "plugins");
const BANNED = [
  ["chlo", "e"],
  ["sher", "ry"],
  ["yu", "u"],
  ["mo", "mo"],
  ["oniic", "han"],
  ["imou", "to"],
  ["persona", ""],
].map((parts) => parts.join(""));
const REAL_NAME = new RegExp(`\\b${["stel", "la"].join("")}\\b`, "i");

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.name === "node_modules" ? [] : e.isDirectory() ? filesUnder(join(dir, e.name)) : [join(dir, e.name)],
  );
}

test("claude-code plugin: a fresh home lists the seeded claude-code agents ready, with no reason", async (t) => {
  const home = tempHome();
  const core = await startCore({ home: home.dir, port: 0, schedule: false });
  t.after(async () => {
    await core.close();
    home.cleanup();
  });
  const tokens = ensureTokens(home.dir, SEED_CALLERS);
  const get = async (path: string) =>
    fetch(core.url + path, { headers: { authorization: `Bearer ${tokens.owner!}` } }).then((r) => r.json());
  const agents = ((await get("/api/agents")) as { agents: { id: string; runtime: string; available: boolean; reason?: string }[] })
    .agents;
  for (const id of ["ada", "cyd"]) {
    const row = agents.find((a) => a.id === id)!;
    assert.equal(row.runtime, "claude-code");
    assert.equal(row.available, true, row.reason ?? "ready");
    assert.equal(row.reason, undefined);
  }
  const plugins = ((await get("/api/plugins")) as { plugins: PluginInfo[] }).plugins;
  const claude = plugins.find((p) => p.id === "claude-code")!;
  assert.deepEqual([claude.enabled, claude.bundled, claude.runtimes, claude.error], [true, true, ["claude-code"], undefined]);
});

test("claude-code plugin: the lounge plugin folder holds no persona name", () => {
  const hits: string[] = [];
  for (const file of filesUnder(PLUGINS)) {
    const text = readFileSync(file, "utf8");
    const lower = text.toLowerCase();
    for (const name of BANNED) if (lower.includes(name)) hits.push(`${relative(PLUGINS, file)}: ${name}`);
    if (REAL_NAME.test(text)) hits.push(`${relative(PLUGINS, file)}: real name`);
  }
  assert.deepEqual(hits, []);
});
