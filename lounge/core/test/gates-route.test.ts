import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { startCore } from "../src/api/http.ts";
import { can } from "../src/auth/permissions.ts";
import { GRANT_GROUPS } from "../src/auth/grants.ts";
import { TOOL_MODULES } from "../src/mcp/server.ts";
import type { ToolContext } from "../src/mcp/server.ts";
import { LoungeError } from "../src/lounge/room.ts";
import { tempHome } from "./helpers.ts";

interface Card {
  id: string;
  agent: string;
  tool: string;
  gate?: { phase: string; file: string; roomId: string };
}

async function boot(t: TestContext) {
  const home = tempHome();
  const core = await startCore({ home: home.dir, port: 0, schedule: false });
  const tokens = JSON.parse(readFileSync(join(home.dir, "tokens.json"), "utf8")) as Record<string, string>;
  const clients: Client[] = [];
  t.after(async () => {
    for (const c of clients) await c.close();
    await core.close();
    home.cleanup();
  });
  const api = (as: string, path: string, init: RequestInit = {}) =>
    fetch(core.url + path, { ...init, headers: { "content-type": "application/json", authorization: `Bearer ${tokens[as]}` } });
  const connect = async (as: string): Promise<Client> => {
    const transport = new StreamableHTTPClientTransport(new URL(`${core.url}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${tokens[as]}` } },
    });
    const client = new Client({ name: "test", version: "0.0.0" });
    await client.connect(transport);
    clients.push(client);
    return client;
  };
  const thread = (await (
    await api("owner", "/api/threads", {
      method: "POST",
      body: JSON.stringify({ channel: "lounge", title: "Plan the lounge", brief: "go", lead: "ada" }),
    })
  ).json()) as { id: string };
  const gateCard = async (): Promise<Card> => {
    for (let i = 0; i < 300; i++) {
      const g = (await (await api("owner", "/api/guard")).json()) as { pending: Card[] };
      const card = g.pending.find((c) => c.gate !== undefined);
      if (card) return card;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error("no gate card");
  };
  const decide = (as: string, id: string, body: unknown) =>
    api(as, `/api/gates/${id}/decide`, { method: "POST", body: JSON.stringify(body) });
  return { core, api, connect, thread, gateCard, decide };
}

const textOf = (r: unknown): string => {
  const first = (r as CallToolResult).content[0];
  return first && first.type === "text" ? first.text : "";
};

test("SC27: lounge_gate blocks the agent turn; the card shows beside guard cards; Approve posts to the thread and returns to the agent", async (t) => {
  const h = await boot(t);
  const ada = await h.connect("ada");
  const call = ada.callTool({
    name: "lounge_gate",
    arguments: { room: h.thread.id, phase: "design", summary: "The design is ready.", file: "design.md" },
  });
  let settled = false;
  void call.then(() => (settled = true));
  const card = await h.gateCard();
  assert.equal(card.agent, "ada");
  assert.equal(card.tool, "lounge_gate");
  assert.deepEqual(card.gate, { phase: "design", file: "design.md", roomId: h.thread.id });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(settled, false, "the call waits for the decision");
  const threads = (await (await h.api("owner", "/api/threads")).json()) as { id: string; phase?: string }[];
  assert.equal(threads.find((x) => x.id === h.thread.id)?.phase, "design");

  const res = await h.decide("owner", card.id, { decision: "approve", note: "go on" });
  assert.equal(res.status, 200);
  assert.equal(textOf(await call), "approved: go on");
  const messages = (await (await h.api("owner", `/api/rooms/${h.thread.id}/messages`)).json()) as { author: string; text: string }[];
  assert.ok(messages.some((m) => m.author === "owner" && m.text === "@ada approved: go on"));
  const after = (await (await h.api("owner", "/api/guard")).json()) as { pending: Card[] };
  assert.deepEqual(after.pending.filter((c) => c.gate), []);
});

test("SC28: a gate decided again gives 409; an unknown gate 404; an agent token 403; a bad body 400", async (t) => {
  const h = await boot(t);
  const ada = await h.connect("ada");
  void ada.callTool({ name: "lounge_gate", arguments: { room: h.thread.id, phase: "plan", summary: "Plan." } });
  const card = await h.gateCard();
  assert.equal((await h.decide("ada", card.id, { decision: "approve" })).status, 403);
  assert.equal((await h.decide("owner", card.id, { decision: "maybe" })).status, 400);
  assert.equal((await h.decide("owner", "nope", { decision: "approve" })).status, 404);
  assert.equal((await h.decide("owner", card.id, { decision: "change", note: "redo" })).status, 200);
  assert.equal((await h.decide("owner", card.id, { decision: "approve" })).status, 409);
  const messages = (await (await h.api("owner", `/api/rooms/${h.thread.id}/messages`)).json()) as { text: string }[];
  assert.equal(messages.filter((m) => m.text.startsWith("@ada ")).length, 1);
});

test("gates: stopping the thread ends the blocked call; the card stays and its decision posts an event line", async (t) => {
  const h = await boot(t);
  const ada = await h.connect("ada");
  const call = ada.callTool({ name: "lounge_gate", arguments: { room: h.thread.id, phase: "design", summary: "Ready." } });
  const card = await h.gateCard();
  assert.equal((await h.api("owner", `/api/threads/${h.thread.id}/stop`, { method: "POST" })).status, 200);
  assert.equal(textOf(await call), "cancelled");
  assert.equal((await h.decide("owner", card.id, { decision: "approve" })).status, 200);
  assert.equal((await h.decide("owner", card.id, { decision: "approve" })).status, 409);
  const messages = (await (await h.api("owner", `/api/rooms/${h.thread.id}/messages`)).json()) as { text: string; kind?: string }[];
  assert.equal(messages.find((m) => m.text === "@ada approved")?.kind, "event");
});

test("gates: lounge_gate is a tool module of the threads grant group, and an agent may use it", () => {
  assert.ok(TOOL_MODULES.some((m) => m.name === "lounge_gate"));
  assert.ok(GRANT_GROUPS.find((g) => g.id === "threads")?.tools.includes("lounge_gate"));
  assert.equal(can({ caller: "ada", restricted: true }, "lounge_gate"), true);
});

test("gates: the tool takes the thread from the one thread the agent works in, and asks for room when it is unclear", async () => {
  const tool = TOOL_MODULES.find((m) => m.name === "lounge_gate")!;
  const opened: unknown[] = [];
  const gates = { add: (input: unknown) => (opened.push(input), Promise.resolve({ status: "approved", note: "yes" })) };
  const ctx = (work: { agent: string; roomId: string }[], caller = "ada"): ToolContext =>
    ({ caller, deps: { gates, threads: { work: () => work } } }) as unknown as ToolContext;
  const args = { phase: "design", summary: "s", file: "f.md" };
  assert.equal(await tool.run(args, ctx([{ agent: "ada", roomId: "thread-1" }, { agent: "bob", roomId: "thread-2" }])), "approved: yes");
  assert.deepEqual(opened[0], { agent: "ada", roomId: "thread-1", phase: "design", summary: "s", file: "f.md" });
  const clash = (err: unknown) => err instanceof LoungeError && err.code === "bad_thread";
  assert.throws(() => tool.run(args, ctx([])), clash);
  assert.throws(() => tool.run(args, ctx([{ agent: "ada", roomId: "a" }, { agent: "ada", roomId: "b" }])), clash);
  assert.throws(() => tool.run(args, ctx([], "owner")), (err) => err instanceof LoungeError && err.code === "forbidden");
});
