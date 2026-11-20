import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Caller } from "../src/config.ts";
import { openDb } from "../src/db/db.ts";
import { ensureTokens } from "../src/auth/tokens.ts";
import { Room } from "../src/lounge/room.ts";
import { createMcpHandler, type McpOptions } from "../src/mcp/server.ts";
import type { RestrictedTokens } from "../src/auth/restricted.ts";
import { sessionDeps, tempHome, SEED_CALLERS } from "./helpers.ts";

interface Harness {
  url: string;
  room: Room;
  restricted: RestrictedTokens;
  tokens: Record<Caller, string>;
  connect(caller: Caller): Promise<{ client: Client; transport: StreamableHTTPClientTransport }>;
}

async function setup(t: TestContext, options: McpOptions = {}): Promise<Harness> {
  const home = tempHome();
  const db = openDb(join(home.dir, "lounge.db"));
  const room = new Room(db);
  const tokens = ensureTokens(home.dir, SEED_CALLERS);
  const deps = sessionDeps({ db, room, home: home.dir });
  const handler = createMcpHandler({ room, tokens, ...deps }, options);
  const server = createServer((req, res) => {
    void handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}/mcp`;
  const clients: Client[] = [];
  t.after(async () => {
    for (const client of clients) await client.close();
    await handler.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    db.close();
    home.cleanup();
  });
  return {
    url,
    room,
    restricted: deps.restricted,
    tokens,
    async connect(caller) {
      const transport = new StreamableHTTPClientTransport(new URL(url), {
        requestInit: { headers: { Authorization: `Bearer ${tokens[caller]}` } },
      });
      const client = new Client({ name: `test-${caller}`, version: "0.0.0" });
      await client.connect(transport);
      clients.push(client);
      return { client, transport };
    },
  };
}

function textOf(result: unknown): string {
  const content = (result as { content: { type: string; text: string }[] }).content;
  return content.map((c) => c.text).join("");
}

const INIT_BODY = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "raw", version: "0.0.0" },
  },
});

const LIST_BODY = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });

function rawPost(url: string, headers: Record<string, string>, body = INIT_BODY) {
  return fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...headers,
    },
    body,
  });
}

test("ada posts and the message author is ada", async (t) => {
  const h = await setup(t);
  const { client } = await h.connect("ada");
  const result = await client.callTool({
    name: "lounge_post",
    arguments: { room: "lounge", text: "hello from mcp" },
  });
  assert.notEqual(result.isError, true);
  const { id } = JSON.parse(textOf(result));
  const stored = h.room.read("lounge");
  assert.equal(stored.length, 1);
  assert.equal(stored[0].id, id);
  assert.equal(stored[0].author, "ada");

  const read = await client.callTool({ name: "lounge_read", arguments: { room: "lounge" } });
  assert.deepEqual(JSON.parse(textOf(read)), stored);
});

test("the post schema has no author field", async (t) => {
  const h = await setup(t);
  const { client } = await h.connect("ada");
  const { tools } = await client.listTools();
  const post = tools.find((tool) => tool.name === "lounge_post");
  assert.ok(post, "lounge_post is listed");
  assert.deepEqual(Object.keys(post.inputSchema.properties ?? {}).sort(), ["attachments", "replyTo", "room", "text"]);
  for (const tool of tools) {
    const keys = Object.keys(tool.inputSchema.properties ?? {});
    assert.ok(!keys.includes("author"), `${tool.name} has an author field`);
    assert.ok(!keys.includes("caller"), `${tool.name} has a caller field`);
  }
});

test("dee cannot post as ada", async (t) => {
  const h = await setup(t);
  const { client } = await h.connect("dee");
  await client.callTool({
    name: "lounge_post",
    arguments: { room: "lounge", text: "i am ada", author: "ada" },
  });
  const stored = h.room.read("lounge");
  assert.ok(stored.every((m) => m.author === "dee"), JSON.stringify(stored));
  assert.ok(!stored.some((m) => m.author === "ada"));
});

test("missing Authorization returns 401", async (t) => {
  const h = await setup(t);
  const res = await rawPost(h.url, {});
  assert.equal(res.status, 401);
  assert.match(res.headers.get("www-authenticate") ?? "", /^Bearer/);
});

test("Bearer garbage returns 401", async (t) => {
  const h = await setup(t);
  const res = await rawPost(h.url, { authorization: "Bearer garbage" });
  assert.equal(res.status, 401);
});

test("Basic xyz returns 401", async (t) => {
  const h = await setup(t);
  const res = await rawPost(h.url, { authorization: "Basic xyz" });
  assert.equal(res.status, 401);
  const res2 = await rawPost(h.url, { authorization: `Basic ${h.tokens.ada}` });
  assert.equal(res2.status, 401);
});

test("session reuse with another token returns 403", async (t) => {
  const h = await setup(t);
  const { transport } = await h.connect("ada");
  const sessionId = transport.sessionId;
  assert.ok(sessionId, "ada has a session id");
  const headers = { "mcp-session-id": sessionId, "mcp-protocol-version": "2025-06-18" };

  const stolen = await rawPost(
    h.url,
    { ...headers, authorization: `Bearer ${h.tokens.dee}` },
    LIST_BODY,
  );
  assert.equal(stolen.status, 403);
  await stolen.body?.cancel();

  const own = await rawPost(
    h.url,
    { ...headers, authorization: `Bearer ${h.tokens.ada}` },
    LIST_BODY,
  );
  assert.equal(own.status, 200);
  await own.body?.cancel();
});

test("a POST with an unknown session id is served without a session", async (t) => {
  const h = await setup(t);
  const res = await rawPost(
    h.url,
    { authorization: `Bearer ${h.tokens.ada}`, "mcp-session-id": "no-such-session" },
    LIST_BODY,
  );
  assert.equal(res.status, 200);
  assert.match(await res.text(), /lounge_post/);
  assert.equal((await getWith(h, "ada", "no-such-session")).status, 404);
  const bad = await rawPost(h.url, { authorization: "Bearer nope", "mcp-session-id": "no-such-session" }, LIST_BODY);
  assert.equal(bad.status, 401);
});

test("a stale session id still runs a tool call", async (t) => {
  let clock = 1_000_000;
  const h = await setup(t, { idleMs: 1000, now: () => clock });
  const { transport } = await h.connect("cyd");
  const sessionId = transport.sessionId!;
  clock += 5000;
  const call = JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "lounge_channels", arguments: {} } });
  const res = await rawPost(
    h.url,
    { authorization: `Bearer ${h.tokens.cyd}`, "mcp-session-id": sessionId, "mcp-protocol-version": "2025-06-18" },
    call,
  );
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /lounge/);
  assert.doesNotMatch(body, /"isError":true/);
});

test("bad text returns isError with bad_text message", async (t) => {
  const h = await setup(t);
  const { client } = await h.connect("ada");
  for (const text of ["", "   ", "a".repeat(2001)]) {
    const result = await client.callTool({
      name: "lounge_post",
      arguments: { room: "lounge", text },
    });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /^bad_text: /);
  }
  const long = await client.callTool({ name: "lounge_post", arguments: { room: "lounge", text: "a".repeat(2001) } });
  assert.match(textOf(long), /2001 characters; a post here has at most 2000\. Write it shorter/);
  const missing = await client.callTool({
    name: "lounge_post",
    arguments: { room: "nope", text: "hi" },
  });
  assert.equal(missing.isError, true);
  assert.match(textOf(missing), /unknown room: nope/);
  assert.deepEqual(h.room.read("lounge"), []);
});

test("lounge_who reports bea and dee unavailable", async (t) => {
  const h = await setup(t);
  const { client } = await h.connect("cyd");
  const result = await client.callTool({ name: "lounge_who", arguments: {} });
  const who = JSON.parse(textOf(result)) as {
    caller: string;
    lastSeen: string | null;
    adapter?: string;
  }[];
  const by = new Map(who.map((w) => [w.caller, w]));
  assert.equal(by.get("bea")?.adapter, "unavailable");
  assert.equal(by.get("ada")?.adapter, "enabled");
  assert.equal(by.get("dee")?.adapter, "unavailable");
  assert.equal(by.get("cyd")?.adapter, "enabled");
  assert.ok(by.has("owner"));
  assert.notEqual(by.get("cyd")?.lastSeen, null, "the tool call touches the caller");
  assert.equal(by.get("ada")?.lastSeen, null);
});

function getWith(h: Harness, caller: Caller, sessionId: string) {
  return fetch(h.url, {
    method: "GET",
    headers: {
      accept: "text/event-stream",
      authorization: `Bearer ${h.tokens[caller]}`,
      "mcp-session-id": sessionId,
    },
  });
}

function listWith(h: Harness, caller: Caller, sessionId: string) {
  return rawPost(
    h.url,
    {
      authorization: `Bearer ${h.tokens[caller]}`,
      "mcp-session-id": sessionId,
      "mcp-protocol-version": "2025-06-18",
    },
    LIST_BODY,
  );
}

test("an idle session expires; GET returns 404", async (t) => {
  let clock = 1_000_000;
  const h = await setup(t, { idleMs: 1000, now: () => clock });
  const { transport } = await h.connect("ada");
  const sessionId = transport.sessionId;
  assert.ok(sessionId);

  clock += 999;
  const fresh = await listWith(h, "ada", sessionId);
  assert.equal(fresh.status, 200);
  await fresh.body?.cancel();

  clock += 1001;
  const stale = await getWith(h, "ada", sessionId);
  assert.equal(stale.status, 404);
});

test("a session over the per-caller cap evicts the oldest", async (t) => {
  const h = await setup(t, { maxPerCaller: 2 });
  const dee = await h.connect("dee");
  const first = await h.connect("ada");
  await h.connect("ada");
  const third = await h.connect("ada");

  const evicted = await getWith(h, "ada", first.transport.sessionId!);
  assert.equal(evicted.status, 404);
  const newest = await listWith(h, "ada", third.transport.sessionId!);
  assert.equal(newest.status, 200);
  await newest.body?.cancel();
  const other = await listWith(h, "dee", dee.transport.sessionId!);
  assert.equal(other.status, 200);
  await other.body?.cancel();
});

test("restricted sessions do not count against the full-token cap", async (t) => {
  const h = await setup(t, { maxPerCaller: 1 });
  const own = await h.connect("ada");
  for (let i = 0; i < 2; i++) {
    const token = h.restricted.mint("ada", `s${i}`);
    const transport = new StreamableHTTPClientTransport(new URL(h.url), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    });
    const client = new Client({ name: "restricted", version: "0.0.0" });
    await client.connect(transport);
    t.after(() => client.close());
  }
  const tools = await own.client.listTools();
  assert.ok(tools.tools.length > 0);
});

test("a revoked token loses its MCP session", async (t) => {
  const h = await setup(t);
  const token = h.restricted.mint("ada", "s1");
  const transport = new StreamableHTTPClientTransport(new URL(h.url), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: "restricted", version: "0.0.0" });
  await client.connect(transport);
  t.after(() => client.close());
  h.restricted.revoke(token);
  await assert.rejects(client.listTools());
});

test("lounge_who marks callers with an open full-token session reachable", async (t) => {
  const h = await setup(t);
  const { client } = await h.connect("cyd");
  const token = h.restricted.mint("bea", "s1");
  const transport = new StreamableHTTPClientTransport(new URL(h.url), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const bea = new Client({ name: "test-restricted", version: "0.0.0" });
  await bea.connect(transport);
  t.after(() => bea.close());
  const result = await client.callTool({ name: "lounge_who", arguments: {} });
  const who = JSON.parse(textOf(result)) as { caller: string; reachable: boolean }[];
  const by = new Map(who.map((w) => [w.caller, w.reachable]));
  assert.equal(by.get("cyd"), true);
  assert.equal(by.get("bea"), false, "a restricted session does not count");
  assert.equal(by.get("ada"), false);
});

test("lounge_channels lists channels with topics", async (t) => {
  const h = await setup(t);
  h.room.setTopic("lounge", "snacks", "owner");
  const { client } = await h.connect("dee");
  const result = await client.callTool({ name: "lounge_channels", arguments: {} });
  assert.deepEqual(JSON.parse(textOf(result)), [{ id: "lounge", name: "Lounge", topic: "snacks" }]);
});

test("lounge_nick sets the caller's own name", async (t) => {
  const h = await setup(t);
  const { client } = await h.connect("cyd");
  const result = await client.callTool({ name: "lounge_nick", arguments: { name: "Cyd the Whale" } });
  assert.deepEqual(JSON.parse(textOf(result)), { caller: "cyd", name: "Cyd the Whale" });
  assert.deepEqual(h.room.nicknames(), { cyd: "Cyd the Whale" });
  const bad = await client.callTool({ name: "lounge_nick", arguments: { name: "x".repeat(40) } });
  assert.equal(bad.isError, true);
});

test("an agent schedules and cancels her own event over MCP", async (t) => {
  const h = await setup(t);
  const { client } = await h.connect("ada");
  const at = new Date(Date.now() + 3_600_000).toISOString();
  const made = await client.callTool({ name: "lounge_schedule", arguments: { title: "Tea", at, context: "green tea" } });
  const event = JSON.parse(textOf(made)) as { id: number; createdBy: string };
  assert.equal(event.createdBy, "ada");
  const list = await client.callTool({ name: "lounge_events", arguments: {} });
  assert.equal((JSON.parse(textOf(list)) as unknown[]).length, 1);
  const { client: cyd } = await h.connect("cyd");
  const denied = await cyd.callTool({ name: "lounge_unschedule", arguments: { id: event.id } });
  assert.equal(denied.isError, true);
  const done = await client.callTool({ name: "lounge_unschedule", arguments: { id: event.id } });
  assert.equal((JSON.parse(textOf(done)) as { state: string }).state, "cancelled");
});

test("lounge_thread_start returns open threads and creates nothing", async (t) => {
  const h = await setup(t);
  const { client } = await h.connect("ada");
  const start = (args: Record<string, unknown>) => client.callTool({ name: "lounge_thread_start", arguments: args });
  const first = JSON.parse(textOf(await start({ channel: "lounge", title: "Fix the build", brief: "go" }))) as { id: string };
  const count = () => h.room.channels().filter((c) => c.parent === "lounge").length;
  assert.equal(count(), 1);

  const again = JSON.parse(textOf(await start({ channel: "lounge", title: "Write the docs", brief: "go" }))) as {
    existing: { id: string; title: string }[];
    note: string;
  };
  assert.deepEqual(again.existing.map((x) => x.id), [first.id]);
  assert.match(again.note, /lounge_post/);
  assert.match(again.note, new RegExp(first.id));
  assert.match(again.note, /force/);
  assert.equal(count(), 1, "nothing is created");

  const forced = JSON.parse(
    textOf(await start({ channel: "lounge", title: "Write the docs", brief: "go", force: true, reason: "separate work for @cyd" })),
  ) as { id: string; parent: string };
  assert.equal(forced.parent, "lounge");
  assert.equal(count(), 2);
  const said = h.room.read(forced.id).map((m) => m.text).join("\n");
  assert.ok(said.includes("separate work for cyd"));
  assert.ok(!said.includes("@cyd"), "a reason starts no turn");
});

test("lounge_thread_start puts a like title first", async (t) => {
  const h = await setup(t);
  const { client } = await h.connect("ada");
  const start = (args: Record<string, unknown>) => client.callTool({ name: "lounge_thread_start", arguments: args });
  await start({ channel: "lounge", title: "Plan a party", brief: "go" });
  const like = JSON.parse(
    textOf(await start({ channel: "lounge", title: "Fix the lounge build", brief: "go", force: true })),
  ) as { id: string };
  const result = JSON.parse(textOf(await start({ channel: "lounge", title: "fix lounge build", brief: "go" }))) as {
    existing: { id: string }[];
  };
  assert.equal(result.existing.length, 2);
  assert.equal(result.existing[0]!.id, like.id);
});

test("lounge_threads lists the open threads of a channel", async (t) => {
  const h = await setup(t);
  const { client } = await h.connect("ada");
  const list = async (channel: string) => client.callTool({ name: "lounge_threads", arguments: { channel } });
  assert.deepEqual(JSON.parse(textOf(await list("lounge"))), []);
  const made = JSON.parse(
    textOf(await client.callTool({ name: "lounge_thread_start", arguments: { channel: "lounge", title: "Fix the build", brief: "go" } })),
  ) as { id: string };
  const threads = JSON.parse(textOf(await list("lounge"))) as { id: string; title: string; lead: string; last: string }[];
  assert.equal(threads.length, 1);
  assert.equal(threads[0]!.id, made.id);
  assert.equal(threads[0]!.title, "Fix the build");
  assert.equal(threads[0]!.lead, "ada");
  assert.ok(threads[0]!.last);
  const bad = await list("nowhere");
  assert.equal(bad.isError, true);
  assert.match(textOf(bad), /Valid channels: lounge/);
});
