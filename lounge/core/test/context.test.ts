import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildContext } from "../src/adapters/context.ts";
import { startCore } from "../src/api/http.ts";
import type { ChatTurnInput, ChatTurnResult } from "../src/adapters/types.ts";
import type { RuntimeKind } from "../src/roster/types.ts";
import { tempHome } from "./helpers.ts";

interface Tree {
  project: string;
  wiki: string;
  cleanup(): void;
}

// A project folder and a wiki folder under the temp folder. The wiki folder does not exist yet.
function tree(): Tree {
  const dir = mkdtempSync(join(tmpdir(), "lounge-context-"));
  const project = join(dir, "project");
  mkdirSync(project);
  return { project, wiki: join(dir, "wiki", "project"), cleanup: () => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }) };
}

function put(path: string, text: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
}

// Every path under a folder with its size and time, so a write or a touch shows.
function listing(dir: string): string[] {
  const out: string[] = [];
  const walk = (at: string): void => {
    for (const name of readdirSync(at).sort()) {
      const path = join(at, name);
      const info = statSync(path);
      out.push(`${path} ${info.isDirectory() ? "dir" : info.size} ${info.mtimeMs}`);
      if (info.isDirectory()) walk(path);
    }
  };
  walk(dir);
  return out;
}

const NATIVE = { agents: "AGENTS.md text", claude: "CLAUDE.md text" };

function fill(t: Tree): void {
  put(join(t.project, "AGENTS.md"), NATIVE.agents);
  put(join(t.project, "CLAUDE.md"), NATIVE.claude);
  put(join(t.project, "memories.md"), "memories text");
  put(join(t.wiki, "index.md"), "wiki index text");
  put(join(t.project, "agent-notes.md"), "instruction text");
}

const RUNTIMES = ["claude-code", "codex"] as const;

test("sc8: with the toggle unset or on, both project files are in the context for a Claude and a Codex agent", (t) => {
  const tr = tree();
  t.after(tr.cleanup);
  fill(tr);
  for (const runtime of RUNTIMES) {
    for (const agent of [{ runtime }, { runtime, insertProjectFiles: true }]) {
      const text = buildContext({ agent, projectDir: tr.project, wikiDir: tr.wiki });
      assert.ok(text.includes(NATIVE.agents), runtime);
      assert.ok(text.includes(NATIVE.claude), runtime);
    }
  }
});

test("sc8: with the toggle off neither project file is in the context, and the other sources stay", (t) => {
  const tr = tree();
  t.after(tr.cleanup);
  fill(tr);
  const on = buildContext({ agent: {}, projectDir: tr.project, wikiDir: tr.wiki });
  for (const runtime of RUNTIMES) {
    const agent = { runtime, insertProjectFiles: false, instructionFile: "agent-notes.md" };
    const text = buildContext({ agent, projectDir: tr.project, wikiDir: tr.wiki });
    assert.ok(!text.includes(NATIVE.agents), runtime);
    assert.ok(!text.includes(NATIVE.claude), runtime);
    assert.ok(text.includes("memories text"), runtime);
    assert.ok(text.includes("wiki index text"), runtime);
    assert.ok(text.includes("instruction text"), runtime);
  }
  // Both runtimes read the same rule: the text does not depend on the runtime name.
  const claude = buildContext({ agent: { runtime: "claude-code", insertProjectFiles: false }, projectDir: tr.project, wikiDir: tr.wiki });
  const codex = buildContext({ agent: { runtime: "codex", insertProjectFiles: false }, projectDir: tr.project, wikiDir: tr.wiki });
  assert.equal(claude, codex);
  assert.notEqual(claude, on);
});

test("sc8: a value that is not false leaves the toggle on", (t) => {
  const tr = tree();
  t.after(tr.cleanup);
  fill(tr);
  for (const value of ["off", 0, null, "false"]) {
    const text = buildContext({ agent: { insertProjectFiles: value }, projectDir: tr.project, wikiDir: tr.wiki });
    assert.ok(text.includes(NATIVE.agents), String(value));
  }
});

test("sc8: an agent can point to a CLAUDE.md or an AGENTS.md as its instruction file", (t) => {
  const tr = tree();
  t.after(tr.cleanup);
  put(join(tr.project, "AGENTS.md"), "project agents");
  put(join(tr.project, "personas", "CLAUDE.md"), "persona claude");
  put(join(tr.project, "personas", "AGENTS.md"), "persona agents");
  const relative = buildContext({ agent: { instructionFile: join("personas", "CLAUDE.md") }, projectDir: tr.project, wikiDir: null });
  assert.ok(relative.includes("persona claude"));
  const absolute = buildContext({ agent: { instructionFile: join(tr.project, "personas", "AGENTS.md") }, projectDir: tr.project, wikiDir: null });
  assert.ok(absolute.includes("persona agents"));
  // The instruction file comes first, even with the toggle off.
  const off = buildContext({ agent: { instructionFile: join("personas", "CLAUDE.md"), insertProjectFiles: false }, projectDir: tr.project, wikiDir: null });
  assert.ok(off.includes("persona claude"));
  assert.ok(!off.includes("project agents"));
  assert.ok(relative.indexOf("persona claude") < relative.indexOf("project agents"));
});

test("sc8: a missing, a blank, a wrong-typed, or a folder instruction file adds nothing and does not throw", (t) => {
  const tr = tree();
  t.after(tr.cleanup);
  mkdirSync(join(tr.project, "folder"));
  const base = buildContext({ agent: {}, projectDir: tr.project, wikiDir: null });
  for (const value of ["missing.md", "", "   ", 7, null, "folder"]) {
    assert.equal(buildContext({ agent: { instructionFile: value }, projectDir: tr.project, wikiDir: null }), base, String(value));
  }
});

test("sc9: with no memories.md no file is created, and nothing in the project or the wiki folder changes", (t) => {
  const tr = tree();
  t.after(tr.cleanup);
  put(join(tr.project, "AGENTS.md"), NATIVE.agents);
  put(join(tr.project, "CLAUDE.md"), NATIVE.claude);
  const before = listing(tr.project);
  const text = buildContext({ agent: {}, projectDir: tr.project, wikiDir: tr.wiki });
  assert.deepEqual(listing(tr.project), before);
  assert.deepEqual(readdirSync(tr.project).sort(), ["AGENTS.md", "CLAUDE.md"]);
  // The wiki folder was absent and stays absent.
  assert.throws(() => statSync(tr.wiki), { code: "ENOENT" });
  assert.ok(!text.includes("memories"));
});

test("sc9: with a wiki folder and no index.md, nothing is created there either", (t) => {
  const tr = tree();
  t.after(tr.cleanup);
  mkdirSync(tr.wiki, { recursive: true });
  const before = [...listing(tr.project), ...listing(tr.wiki)];
  buildContext({ agent: { insertProjectFiles: false }, projectDir: tr.project, wikiDir: tr.wiki });
  assert.deepEqual([...listing(tr.project), ...listing(tr.wiki)], before);
  assert.deepEqual(readdirSync(tr.wiki), []);
});

test("sc9: a project folder that does not exist is not created", (t) => {
  const tr = tree();
  t.after(tr.cleanup);
  const gone = join(tr.project, "nowhere");
  assert.equal(buildContext({ agent: {}, projectDir: gone, wikiDir: null }), "");
  assert.throws(() => statSync(gone), { code: "ENOENT" });
});

const SOURCES = ["instruction", "agents", "claude", "memories", "wiki"] as const;

function plant(t: Tree, source: (typeof SOURCES)[number]): void {
  const files = {
    instruction: join(t.project, "agent-notes.md"),
    agents: join(t.project, "AGENTS.md"),
    claude: join(t.project, "CLAUDE.md"),
    memories: join(t.project, "memories.md"),
    wiki: join(t.wiki, "index.md"),
  };
  put(files[source], `body of ${source}`);
}

test("c5_1: for every subset of present sources the context holds exactly those, in the fixed order", () => {
  for (let mask = 0; mask < 1 << SOURCES.length; mask++) {
    const tr = tree();
    try {
      const present = SOURCES.filter((_, i) => (mask >> i) & 1);
      for (const source of present) plant(tr, source);
      const text = buildContext({ agent: { instructionFile: "agent-notes.md" }, projectDir: tr.project, wikiDir: tr.wiki });
      const found = SOURCES.filter((source) => text.includes(`body of ${source}`));
      assert.deepEqual(found, present, `mask ${mask}`);
      const at = present.map((source) => text.indexOf(`body of ${source}`));
      assert.deepEqual([...at].sort((a, b) => a - b), at, `mask ${mask}`);
    } finally {
      tr.cleanup();
    }
  }
});

test("c5_1: each present source has its own heading, and a missing source has none", (t) => {
  const tr = tree();
  t.after(tr.cleanup);
  plant(tr, "agents");
  plant(tr, "wiki");
  const text = buildContext({ agent: {}, projectDir: tr.project, wikiDir: tr.wiki });
  assert.match(text, /^## Project AGENTS\.md\n\nbody of agents\n/m);
  assert.match(text, /^## Wiki index\n\nbody of wiki\n/m);
  assert.doesNotMatch(text, /CLAUDE\.md|memories\.md/);
});

test("c5_1: the lounge skills and the lounge rules come last, after every file, and no size cap applies", (t) => {
  const tr = tree();
  t.after(tr.cleanup);
  fill(tr);
  const big = "x".repeat(2 * 1024 * 1024);
  put(join(tr.project, "memories.md"), `${big}END`);
  const text = buildContext({
    agent: { instructionFile: "agent-notes.md" },
    projectDir: tr.project,
    wikiDir: tr.wiki,
    skillIndex: [{ name: "wiki", description: "Wiki rules." }],
    loungeRules: "Answer in haiku.",
  });
  assert.ok(text.includes(`${big}END`));
  const at = (needle: string) => text.indexOf(needle);
  assert.ok(at("wiki index text") < at("## Lounge skills"));
  assert.ok(at("## Lounge skills") < at("## Lounge rules"));
  assert.match(text, /- wiki: Wiki rules\./);
  assert.ok(text.trimEnd().endsWith("Answer in haiku."));
});

test("c5_1: without skills or rules the context has no such section", (t) => {
  const tr = tree();
  t.after(tr.cleanup);
  fill(tr);
  for (const extra of [{}, { skillIndex: [], loungeRules: "  " }]) {
    const text = buildContext({ agent: {}, projectDir: tr.project, wikiDir: tr.wiki, ...extra });
    assert.doesNotMatch(text, /## Lounge skills|## Lounge rules/);
  }
});

test("c5_2: the builder source calls read functions of fs only", () => {
  const source = readFileSync(join(import.meta.dirname, "..", "src", "adapters", "context.ts"), "utf8");
  const calls = [...source.matchAll(/\bfs\.(\w+)/g)].map((m) => m[1]).sort();
  assert.ok(calls.length > 0);
  assert.ok(calls.every((name) => name === "existsSync" || name === "readFileSync"), calls.join(","));
  assert.doesNotMatch(source, /from "node:fs\/promises"|require\(|child_process|writeFile|appendFile|mkdir|unlink|rmSync|rename|copyFile/);
});

test("c5_2: after many builds over missing and present files the folders hold the same files", (t) => {
  const tr = tree();
  t.after(tr.cleanup);
  put(join(tr.project, "CLAUDE.md"), NATIVE.claude);
  const before = listing(tr.project);
  for (const insertProjectFiles of [true, false, undefined]) {
    buildContext({ agent: { insertProjectFiles, instructionFile: "none.md" }, projectDir: tr.project, wikiDir: tr.wiki });
  }
  assert.deepEqual(listing(tr.project), before);
});

async function waitFor(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`timed out: ${what}`);
}

test("sc8: a turn the core starts carries the project files in the system text, before the reply rules", async (t: TestContext) => {
  const home = tempHome();
  const tr = tree();
  fill(tr);
  writeFileSync(
    join(home.dir, "config.json"),
    JSON.stringify({ adapters: { ada: { enabled: false }, cyd: { enabled: false } }, scheduler: { replyDelayMs: 0 } }),
  );
  const seen: { runtime: string; agent: string; system: string; chat: string }[] = [];
  const spy = (id: string): RuntimeKind => ({
    id,
    label: `Spy ${id}`,
    efforts: () => [],
    models: () => [],
    create: (_entry, ctx) => ({
      name: id,
      available: async () => ({ ok: true }),
      chatTurn: async (turn: ChatTurnInput): Promise<ChatTurnResult> => {
        seen.push({ runtime: id, agent: turn.agent, system: ctx.prompt.systemText(turn), chat: ctx.prompt.chatPrompt(turn) });
        return { kind: "post", text: "ok" };
      },
    }),
  });
  const core = await startCore({
    home: home.dir,
    port: 0,
    schedule: true,
    runtimes: [spy("spy-a"), spy("spy-b")],
    wiki: { project: tr.project, root: join(tr.wiki, ".."), name: "project" },
  });
  t.after(async () => {
    await core.close();
    home.cleanup();
    tr.cleanup();
  });
  const token = (JSON.parse(readFileSync(join(home.dir, "tokens.json"), "utf8")) as Record<string, string>).owner!;
  const call = (path: string, body: unknown) =>
    fetch(core.url + path, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
  assert.equal((await call("/api/agents", { id: "nana", runtime: "spy-a", options: { instructionFile: "agent-notes.md" } })).status, 201);
  assert.equal((await call("/api/agents", { id: "oko", runtime: "spy-b", options: { insertProjectFiles: false } })).status, 201);
  assert.equal((await call("/api/rooms/lounge/messages", { text: "@nana @oko hello" })).status, 201);
  // Agents answer each other too, so more than one turn each may run.
  await waitFor(() => ["nana", "oko"].every((id) => seen.some((s) => s.agent === id)), "a turn for each agent");
  const nana = seen.find((s) => s.agent === "nana")!;
  const oko = seen.find((s) => s.agent === "oko")!;
  for (const text of [nana.system, nana.chat]) {
    assert.ok(text.includes(NATIVE.agents) && text.includes(NATIVE.claude), text);
    assert.ok(text.includes("instruction text") && text.includes("memories text") && text.includes("wiki index text"));
    assert.ok(text.indexOf("wiki index text") < text.indexOf("- You may use your tools."));
    assert.ok(text.indexOf("## Where you are") < text.indexOf("instruction text"));
  }
  for (const text of [oko.system, oko.chat]) {
    assert.ok(!text.includes(NATIVE.agents) && !text.includes(NATIVE.claude));
    assert.ok(text.includes("memories text") && text.includes("wiki index text"));
  }
});
