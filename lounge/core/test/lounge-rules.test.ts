import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startCore } from "../src/api/http.ts";
import { systemText } from "../src/adapters/prompt.ts";
import type { ChatTurnInput, ChatTurnResult } from "../src/adapters/types.ts";
import type { RuntimeKind } from "../src/roster/types.ts";
import { tempHome } from "./helpers.ts";

const QUIET = { adapters: { ada: { enabled: false }, cyd: { enabled: false } }, scheduler: { replyDelayMs: 0 } };

interface Boot {
  api(path: string, init?: RequestInit & { as?: string | null }): Promise<Response>;
  say(text: string): Promise<void>;
  restart(): Promise<void>;
}

// Records the input of each turn and posts "ok".
function spy(inputs: ChatTurnInput[], id = "spy"): RuntimeKind {
  return {
    id,
    label: "Spy runtime",
    efforts: () => [],
    models: () => ["spy-model-1", "spy-model-2"],
    create: () => ({
      name: "spy",
      available: async () => ({ ok: true }),
      chatTurn: async (input: ChatTurnInput): Promise<ChatTurnResult> => {
        inputs.push(input);
        return { kind: "post", text: "ok" };
      },
    }),
  };
}

async function boot(t: TestContext, runtimes: RuntimeKind[] = []): Promise<Boot> {
  const home = tempHome();
  writeFileSync(join(home.dir, "config.json"), JSON.stringify(QUIET));
  const start = () => startCore({ home: home.dir, port: 0, schedule: true, runtimes });
  let core = await start();
  t.after(async () => {
    await core.close();
    home.cleanup();
  });
  const tokens = () => JSON.parse(readFileSync(join(home.dir, "tokens.json"), "utf8")) as Record<string, string>;
  const api: Boot["api"] = (path, init = {}) => {
    const { as = "owner", ...rest } = init;
    const headers = new Headers(rest.headers);
    if (rest.body !== undefined) headers.set("content-type", "application/json");
    if (as) headers.set("authorization", `Bearer ${tokens()[as]}`);
    return fetch(core.url + path, { ...rest, headers });
  };
  return {
    api,
    async say(text) {
      const res = await api("/api/rooms/lounge/messages", { method: "POST", body: JSON.stringify({ text }) });
      assert.equal(res.status, 201);
    },
    async restart() {
      await core.close();
      core = await start();
    },
  };
}

const put = (h: Boot, body: unknown, as?: string | null) =>
  h.api("/api/lounge/rules", { method: "PUT", body: JSON.stringify(body), as });
const read = async (h: Boot) => (await (await h.api("/api/lounge/rules")).json()) as { text: string };

async function waitFor(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`timed out: ${what}`);
}

test("lounge rules: a new home has empty rules; a saved text survives a restart, as written", async (t) => {
  const h = await boot(t);
  const first = await h.api("/api/lounge/rules");
  assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), { text: "" });

  const text = "  End every message with a cat face.\n\n";
  const saved = await put(h, { text });
  assert.equal(saved.status, 200);
  assert.deepEqual(await saved.json(), { text });
  assert.deepEqual(await read(h), { text });
  await h.restart();
  assert.deepEqual(await read(h), { text });

  // An empty text clears the rules.
  assert.equal((await put(h, { text: "" })).status, 200);
  assert.deepEqual(await read(h), { text: "" });
});

test("lounge rules: a text over 16 KiB of bytes or a non-string text gets bad_rules and changes nothing", async (t) => {
  const h = await boot(t);
  assert.equal((await put(h, { text: "keep me" })).status, 200);

  const limit = 16 * 1024;
  const bad: unknown[] = [
    { text: "a".repeat(limit + 1) },
    // Fewer characters than the limit, more bytes.
    { text: "あ".repeat(Math.floor(limit / 3) + 1) },
    { text: 5 },
    { text: null },
    { text: ["a"] },
    {},
  ];
  for (const body of bad) {
    const res = await put(h, body);
    assert.equal(res.status, 400, JSON.stringify(body).slice(0, 40));
    assert.equal(((await res.json()) as { error: string }).error, "bad_rules");
  }
  assert.deepEqual(await read(h), { text: "keep me" });

  // The limit itself is valid, in bytes.
  assert.equal((await put(h, { text: "a".repeat(limit) })).status, 200);
  assert.equal((await put(h, { text: "あ".repeat(Math.floor(limit / 3)) })).status, 200);
  // Control characters grow in JSON but still fit.
  assert.equal((await put(h, { text: "\u0001".repeat(limit) })).status, 200);
});

test("lounge rules: both routes need the owner token", async (t) => {
  const h = await boot(t);
  for (const as of [null, "ada"]) {
    const expected = as === null ? 401 : 403;
    assert.equal((await h.api("/api/lounge/rules", { as })).status, expected, `GET as ${as}`);
    assert.equal((await put(h, { text: "x" }, as)).status, expected, `PUT as ${as}`);
  }
  assert.deepEqual(await read(h), { text: "" });
  assert.equal((await h.api("/api/lounge/rules", { method: "DELETE" })).status, 405);
});

test("runtime facts: a model hint is not the model; a chosen model is", async (t) => {
  const inputs: ChatTurnInput[] = [];
  const h = await boot(t, [spy(inputs)]);
  const send = (method: string, path: string, body: unknown) =>
    h.api(path, { method, body: JSON.stringify(body) });
  assert.equal((await send("POST", "/api/agents", { id: "kana", runtime: "stub" })).status, 201);
  assert.equal((await send("POST", "/api/agents", { id: "nana", runtime: "spy" })).status, 201);
  const nana = () => inputs.filter((i) => i.agent === "nana");
  const ask = async (n: number) => {
    await h.say(`@nana ask ${n}`);
    await waitFor(() => nana().length === n, `turn ${n}`);
    return nana()[n - 1]!.self!.model;
  };

  // A hint is not what a CLI runs, so the agent is told the default.
  assert.equal(await ask(1), "default model");
  assert.equal((await send("PATCH", "/api/agents/nana", { model: "custom-1" })).status, 200);
  assert.equal(await ask(2), "custom-1");
});

test("lounge rules: a save reaches the next turn of an added agent with her own runtime facts", async (t) => {
  const inputs: ChatTurnInput[] = [];
  const h = await boot(t, [spy(inputs)]);
  const kana = await h.api("/api/agents", { method: "POST", body: JSON.stringify({ id: "kana", runtime: "stub" }) });
  assert.equal(kana.status, 201);
  const made = await h.api("/api/agents", {
    method: "POST",
    body: JSON.stringify({ id: "nana", runtime: "spy", displayName: "Nana-chan" }),
  });
  assert.equal(made.status, 201);

  const nana = () => inputs.filter((i) => i.agent === "nana");
  await h.say("@nana first");
  await waitFor(() => nana().length === 1, "first turn");
  assert.equal(nana()[0]!.loungeRules, "");
  assert.doesNotMatch(systemText(nana()[0]!), /## Lounge rules/);
  assert.deepEqual(
    [nana()[0]!.self?.id, nana()[0]!.self?.runtime, nana()[0]!.self?.model, nana()[0]!.self?.effort],
    ["nana", "Spy runtime", "default model", ""],
  );
  assert.equal(nana()[0]!.self?.name, "Nana-chan");
  const listed = (await (await h.api("/api/agents")).json()) as { agents: { id: string; enabled: boolean }[] };
  const others = listed.agents.filter((e) => e.enabled && e.id !== "nana").map((e) => e.id);
  assert.ok(others.includes("kana"));
  assert.deepEqual(nana()[0]!.members?.map((m) => m.id), others);

  assert.match(systemText(nana()[0]!), /You are "Nana-chan" \(id `nana`\), an agent in the agent lounge/);

  assert.equal((await put(h, { text: "Answer in haiku." })).status, 200);
  await h.say("@nana second");
  await waitFor(() => nana().length === 2, "second turn");
  assert.equal(nana()[1]!.loungeRules, "Answer in haiku.");
  const system = systemText(nana()[1]!);
  assert.ok(system.indexOf("## Where you are") < system.indexOf("## Lounge rules"));
  assert.ok(system.indexOf("Answer in haiku.") < system.indexOf("- You may use your tools."));
});
