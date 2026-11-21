import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { effortsFromHelp, claudeKind } from "../../plugins/claude-code/index.ts";
import { SUBAGENT_DISALLOWED, disallowedTools } from "../../plugins/claude-code/isolate.ts";
import type { AgentEntry } from "../src/roster/types.ts";
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

const FULL = ["low", "medium", "high", "xhigh", "max"];
const CATALOG = {
  models: [
    { id: "big-new", label: "Big New", efforts: FULL, section: "main" },
    { id: "mid-old", label: "Mid Old", efforts: ["low", "medium", "high"], section: "main" },
    { id: "tiny", label: "Tiny", efforts: [], section: "overflow" },
  ],
  aliases: { big: "big-new", mid: "mid-old" },
  fetchedAt: 1,
};
const EMPTY = { models: [], aliases: {}, fetchedAt: 0 };

function entryWith(model: string): AgentEntry {
  return {
    id: "nana",
    runtime: "claude-code",
    model,
    effort: "",
    enabled: true,
    tape: 1,
    options: {},
    position: 0,
    retired: false,
    toolMode: "full",
  };
}

test("c3_1: efforts(entry) gives the catalog efforts of entry.model", () => {
  const kind = claudeKind(CATALOG);
  assert.deepEqual(kind.efforts(entryWith("big-new")), FULL);
  assert.deepEqual(kind.efforts(entryWith("mid-old")), ["low", "medium", "high"]);
  assert.deepEqual(kind.efforts(entryWith("tiny")), []);
  assert.deepEqual(kind.models(entryWith("")), ["big", "mid", "big-new", "mid-old", "tiny"]);
});

test("c3_1: an alias gives the efforts of its default model, and an empty or unknown model gives the union", () => {
  const kind = claudeKind(CATALOG);
  assert.deepEqual(kind.efforts(entryWith("mid")), ["low", "medium", "high"]);
  assert.deepEqual(kind.efforts(entryWith("")), FULL);
  assert.deepEqual(kind.efforts(entryWith("typed-by-hand")), FULL);
});

test("c3_1: an empty catalog gives the --effort list of claude --help", () => {
  const help = [
    "  --disallowed-tools <tools...>         Deny list",
    "  --effort <level>                      Effort level for the current session",
    "                                        (low, medium, high, xhigh, max)",
    "  --environment <environment_id>        Create a cloud session (a, b)",
  ].join("\n");
  assert.deepEqual(effortsFromHelp(help), FULL);
  assert.deepEqual(effortsFromHelp("no such flag (a, b)"), []);
  const kind = claudeKind(EMPTY, effortsFromHelp(help));
  assert.deepEqual(kind.efforts(entryWith("anything")), FULL);
  assert.deepEqual(kind.models(entryWith("")), []);
  assert.deepEqual(claudeKind(EMPTY).efforts(entryWith("")), []);
});

test("c3_2: the claude args disallow Task, Agent, and Workflow in one value", () => {
  assert.equal(SUBAGENT_DISALLOWED, "Task,Agent,Workflow");
  assert.equal(disallowedTools("full"), "--disallowedTools=Task,Agent,Workflow");
  assert.equal(disallowedTools("read-only"), "--disallowedTools=Task,Agent,Workflow,Monitor,Tmux");
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
