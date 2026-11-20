import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Adapter, ChatTurnInput, ChatTurnResult } from "../src/adapters/types.ts";
import type { Caller } from "../src/config.ts";
import { ensureTokens } from "../src/auth/tokens.ts";
import { startCore } from "../src/api/http.ts";
import { tempHome, SEED_CALLERS, fakeKinds } from "./helpers.ts";

async function mcpClient(url: string, token: string, clients: Client[]): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: "session-mcp-test", version: "0.0.0" });
  await client.connect(transport);
  clients.push(client);
  return client;
}

function body(result: unknown): string {
  const content = (result as CallToolResult).content[0];
  return content && content.type === "text" ? content.text : "";
}

// The brief picks the fake runtime's behavior.
class McpFakeAdapter implements Adapter {
  readonly name = "claude" as const;
  url: () => string = () => "";
  tokens: string[] = [];
  openResult = "";
  release?: () => void;
  clients: Client[] = [];

  async available(): Promise<{ ok: boolean; reason?: string }> {
    return { ok: true };
  }

  async chatTurn(input: ChatTurnInput, signal: AbortSignal): Promise<ChatTurnResult> {
    this.tokens.push(input.mcpToken);
    const last = input.context.at(-1)?.text ?? "";
    if (input.brief === "call-open") {
      const client = await mcpClient(this.url(), input.mcpToken, this.clients);
      const result = await client.callTool({
        name: "session_open",
        arguments: { agent: "ada", kind: "chat", brief: "nested" },
      });
      this.openResult = body(result);
      await client.close();
      return { kind: "post", text: "tried" };
    }
    if (input.brief === "call-who") {
      const client = await mcpClient(this.url(), input.mcpToken, this.clients);
      await client.callTool({ name: "lounge_who", arguments: {} });
      return { kind: "pass" };
    }
    if (input.brief === "slow") {
      input.onSlow();
      await new Promise<void>((resolve, reject) => {
        this.release = resolve;
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
      return { kind: "pass" };
    }
    return { kind: "post", text: `echo: ${last}` };
  }
}

interface Harness {
  url: string;
  mcpUrl: string;
  tokens: Record<Caller, string>;
  adapter: McpFakeAdapter;
  connect(caller: Caller): Promise<Client>;
  call(client: Client, name: string, args: Record<string, unknown>): Promise<CallToolResult>;
  waitState(client: Client, id: string, state: string): Promise<void>;
}

async function setup(t: TestContext): Promise<Harness> {
  const home = tempHome();
  const adapter = new McpFakeAdapter();
  const core = await startCore({
    home: home.dir,
    port: 0,
    runtimes: fakeKinds((_entry, ctx) => {
      adapter.url = ctx.mcpUrl;
      return adapter;
    }),
  });
  const clients: Client[] = [];
  t.after(async () => {
    adapter.release?.();
    for (const client of [...clients, ...adapter.clients]) await client.close().catch(() => {});
    await core.close();
    home.cleanup();
  });
  const tokens = ensureTokens(home.dir, SEED_CALLERS);
  const mcpUrl = `${core.url}/mcp`;
  const call = async (client: Client, name: string, args: Record<string, unknown>) =>
    (await client.callTool({ name, arguments: args })) as CallToolResult;
  return {
    url: core.url,
    mcpUrl,
    tokens,
    adapter,
    connect: (caller) => mcpClient(mcpUrl, tokens[caller], clients),
    call,
    async waitState(client, id, state) {
      for (let i = 0; i < 100; i++) {
        const view = JSON.parse(body(await call(client, "session_status", { id }))) as { state: string };
        if (view.state === state) return;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.fail(`session ${id} never reached ${state}`);
    },
  };
}

test("session mcp: a restricted token cannot open sessions and dies after the turn", async (t) => {
  const h = setup(t);
  const { connect, call, waitState, adapter, mcpUrl } = await h;
  const owner = await connect("owner");
  const opened = await call(owner, "session_open", { agent: "ada", kind: "chat", brief: "call-open" });
  assert.equal(opened.isError, undefined, body(opened));
  const { id } = JSON.parse(body(opened)) as { id: string };
  await waitState(owner, id, "idle");
  assert.match(adapter.openResult, /^forbidden/);

  const token = adapter.tokens[0]!;
  const res = await fetch(mcpUrl, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "x", version: "0" } },
    }),
  });
  assert.equal(res.status, 401);
});

test("session mcp: dee may not open sessions or post to session rooms", async (t) => {
  const { connect, call } = await setup(t);
  const owner = await connect("owner");
  const opened = await call(owner, "session_open", { agent: "ada", kind: "chat", brief: "hi" });
  const { roomId } = JSON.parse(body(opened)) as { roomId: string };
  const dee = await connect("dee");
  const denied = await call(dee, "session_open", { agent: "ada", kind: "chat", brief: "hi" });
  assert.equal(denied.isError, true);
  assert.match(body(denied), /^forbidden/);
  const post = await call(dee, "lounge_post", { room: roomId, text: "forged" });
  assert.equal(post.isError, true);
  assert.match(body(post), /^forbidden: session rooms/);
  const own = await call(owner, "lounge_post", { room: roomId, text: "forged" });
  assert.equal(own.isError, true);
});

test("session mcp: session_message returns the reply; an unknown id is a tool error", async (t) => {
  const { connect, call, waitState, url } = await setup(t);
  const owner = await connect("owner");
  const opened = await call(owner, "session_open", { agent: "ada", kind: "chat", brief: "hi" });
  const { id } = JSON.parse(body(opened)) as { id: string };
  await waitState(owner, id, "idle");
  const sent = await call(owner, "session_message", { id, text: "ping" });
  assert.equal(sent.isError, undefined, body(sent));
  const parsed = JSON.parse(body(sent)) as { session: { state: string }; reply?: { text: string } };
  assert.equal(parsed.reply?.text, "echo: ping");
  assert.equal(parsed.session.state, "idle");

  const unknown = await call(owner, "session_message", { id: "nope", text: "ping" });
  assert.equal(unknown.isError, true);
  assert.match(body(unknown), /^unknown_session/);
  const health = await fetch(`${url}/health`);
  assert.equal(health.status, 200);

  const listed = JSON.parse(body(await call(owner, "session_list", {}))) as unknown[];
  assert.equal(listed.length, 1);
});

test("session mcp: a slow turn shows in lounge_who until it ends", async (t) => {
  const { connect, call, waitState, adapter } = await setup(t);
  const owner = await connect("owner");
  const who = async () => {
    const list = JSON.parse(body(await call(owner, "lounge_who", {}))) as {
      caller: string;
      adapter?: string;
    }[];
    return list.find((p) => p.caller === "ada")?.adapter;
  };
  const opened = await call(owner, "session_open", { agent: "ada", kind: "chat", brief: "slow" });
  const { id } = JSON.parse(body(opened)) as { id: string };
  for (let i = 0; i < 100 && !adapter.release; i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(await who(), "slow");
  adapter.release!();
  await waitState(owner, id, "idle");
  assert.equal(await who(), "enabled");
});

test("session mcp: chat turns do not evict ada's own MCP session", async (t) => {
  const { connect, call, waitState } = await setup(t);
  const ada = await connect("ada");
  for (let i = 0; i < 10; i++) {
    const opened = await call(ada, "session_open", { agent: "ada", kind: "chat", brief: "call-who" });
    assert.equal(opened.isError, undefined, body(opened));
    const { id } = JSON.parse(body(opened)) as { id: string };
    await waitState(ada, id, "idle");
  }
  const tools = await ada.listTools();
  assert.ok(tools.tools.some((tool) => tool.name === "session_open"));
});

test("session_close gives the session view and no memory note, for an agent and for the owner", async (t) => {
  const { connect, call, waitState } = await setup(t);
  for (const caller of ["ada", "owner"] as const) {
    const client = await connect(caller);
    const opened = await call(client, "session_open", { agent: "ada", kind: "chat", brief: "call-who" });
    const { id } = JSON.parse(body(opened)) as { id: string };
    await waitState(client, id, "idle");
    const closed = await call(client, "session_close", { id });
    assert.equal(closed.isError, undefined, body(closed));
    assert.equal((JSON.parse(body(closed)) as { state: string }).state, "closed");
    assert.doesNotMatch(body(closed), /memory/);
  }
});
