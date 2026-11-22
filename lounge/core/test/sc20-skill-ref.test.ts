import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startCore } from "../src/api/http.ts";
import { chatPrompt, isPass, systemText, turnText } from "../src/adapters/prompt.ts";
import type { ChatTurnInput, ChatTurnResult } from "../src/adapters/types.ts";
import type { Message } from "../src/lounge/room.ts";
import type { RuntimeKind } from "../src/roster/types.ts";
import { Skills, withSkills } from "../src/skills/skills.ts";
import { tempHome } from "./helpers.ts";

const WIKI_BODY = "Keep the wiki flat. One folder per project.";
const QUIET = { adapters: { ada: { enabled: false }, cyd: { enabled: false } }, scheduler: { replyDelayMs: 0 } };

function writeSkill(home: string, name: string, description: string, body: string): void {
  mkdirSync(join(home, "skills", name), { recursive: true });
  writeFileSync(
    join(home, "skills", name, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n\n${body}\n`,
  );
}

function msg(id: number, author: string, text: string, kind?: Message["kind"]): Message {
  return { id, roomId: "lounge", author, text, createdAt: "2026-11-21T00:00:00.000Z", ...(kind ? { kind } : {}) };
}

function input(context: Message[]): ChatTurnInput {
  return { agent: "ada", brief: "Answer the room.", context, mcpToken: "t", onSlow: () => {} };
}

const BASE = { systemText, turnText, chatPrompt, isPass };

test("SC20: a post with $wiki puts the wiki skill body in the turn text", (t) => {
  const home = tempHome();
  t.after(() => home.cleanup());
  writeSkill(home.dir, "wiki", "Wiki rules.", WIKI_BODY);
  const prompt = withSkills(BASE, new Skills({ home: home.dir }));
  const turn = prompt.turnText(input([msg(1, "owner", "please follow $wiki now")]));
  assert.ok(turn.includes(WIKI_BODY), turn);
  assert.match(turn, /Skill \$wiki/);
  // The post itself stays as text.
  assert.ok(turn.includes("please follow $wiki now"));
  // The same text reaches a runtime that has one prompt only.
  assert.ok(prompt.chatPrompt(input([msg(1, "owner", "$wiki")])).includes(WIKI_BODY));
});

test("SC20: an unknown name, an agent post, and a later owner post without a name attach nothing", (t) => {
  const home = tempHome();
  t.after(() => home.cleanup());
  writeSkill(home.dir, "wiki", "Wiki rules.", WIKI_BODY);
  const prompt = withSkills(BASE, new Skills({ home: home.dir }));
  const unknown = prompt.turnText(input([msg(1, "owner", "use $nothing please")]));
  assert.ok(!unknown.includes("Skill $"), unknown);
  assert.ok(unknown.includes("use $nothing please"));
  // Only the owner's words count.
  const fromAgent = prompt.turnText(input([msg(1, "cyd", "try $wiki")]));
  assert.ok(!fromAgent.includes(WIKI_BODY));
  const asEvent = prompt.turnText(input([msg(1, "owner", "$wiki", "event")]));
  assert.ok(!asEvent.includes(WIKI_BODY));
  // The last owner post decides.
  const later = prompt.turnText(input([msg(1, "owner", "$wiki"), msg(2, "owner", "never mind")]));
  assert.ok(!later.includes(WIKI_BODY));
});

test("SC20: the body stays in the turn while the owner post is the last owner post, even after an agent reply", (t) => {
  const home = tempHome();
  t.after(() => home.cleanup());
  writeSkill(home.dir, "wiki", "Wiki rules.", WIKI_BODY);
  const prompt = withSkills(BASE, new Skills({ home: home.dir }));
  const turn = prompt.turnText(input([msg(1, "owner", "follow $wiki"), msg(2, "cyd", "on it")]));
  assert.ok(turn.includes(WIKI_BODY));
});

test("SC20: the system text lists each skill with its name and description, and no body", (t) => {
  const home = tempHome();
  t.after(() => home.cleanup());
  writeSkill(home.dir, "wiki", "Wiki rules.", WIKI_BODY);
  writeSkill(home.dir, "ste", "Short English.", "Use short words.");
  const prompt = withSkills(BASE, new Skills({ home: home.dir }));
  const system = prompt.systemText(input([]));
  assert.match(system, /## Skills/);
  assert.match(system, /- ste: Short English\./);
  assert.match(system, /- wiki: Wiki rules\./);
  assert.match(system, /lounge_skill/);
  // A $name in a post means that skill.
  assert.match(system, /`\$name` in a post names the skill `name`/);
  assert.ok(!system.includes(WIKI_BODY));
  // The reply rules stay last: room text is data.
  assert.ok(system.indexOf("## Skills") < system.indexOf("- You may use your tools."));
  // No skill, no section.
  const empty = withSkills(BASE, new Skills({ home: join(home.dir, "none") }));
  assert.doesNotMatch(empty.systemText(input([])), /## Skills/);
});

async function waitFor(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`timed out: ${what}`);
}

test("SC20: a turn the core starts for an owner post with $wiki carries the wiki body", async (t: TestContext) => {
  const home = tempHome();
  writeFileSync(join(home.dir, "config.json"), JSON.stringify(QUIET));
  writeSkill(home.dir, "wiki", "Wiki rules.", WIKI_BODY);
  const seen: { system: string; turn: string }[] = [];
  const spy: RuntimeKind = {
    id: "spy",
    label: "Spy runtime",
    efforts: () => [],
    models: () => [],
    create: (_entry, ctx) => ({
      name: "spy",
      available: async () => ({ ok: true }),
      chatTurn: async (turn: ChatTurnInput): Promise<ChatTurnResult> => {
        seen.push({ system: ctx.prompt.systemText(turn), turn: ctx.prompt.turnText(turn) });
        return { kind: "post", text: "ok" };
      },
    }),
  };
  const core = await startCore({ home: home.dir, port: 0, schedule: true, runtimes: [spy] });
  t.after(async () => {
    await core.close();
    home.cleanup();
  });
  const token = (JSON.parse(readFileSync(join(home.dir, "tokens.json"), "utf8")) as Record<string, string>).owner!;
  const call = (path: string, body: unknown) =>
    fetch(core.url + path, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
  assert.equal((await call("/api/agents", { id: "nana", runtime: "spy" })).status, 201);
  assert.equal((await call("/api/rooms/lounge/messages", { text: "@nana follow $wiki" })).status, 201);
  await waitFor(() => seen.length === 1, "the turn");
  assert.ok(seen[0]!.turn.includes(WIKI_BODY), seen[0]!.turn);
  assert.match(seen[0]!.system, /- wiki: Wiki rules\./);
  // A name with no skill stays text.
  assert.equal((await call("/api/rooms/lounge/messages", { text: "@nana follow $nothing" })).status, 201);
  await waitFor(() => seen.length === 2, "the second turn");
  assert.ok(!seen[1]!.turn.includes(WIKI_BODY));
});
