import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { startCore } from "../src/api/http.ts";
import { Grants } from "../src/auth/grants.ts";
import { can } from "../src/auth/permissions.ts";
import { TOOL_MODULES } from "../src/mcp/server.ts";
import { openDb } from "../src/db/db.ts";
import { tempHome } from "./helpers.ts";

const WIKI_BODY = "Keep the wiki flat.\nOne folder per project.";

async function boot(t: TestContext) {
  const home = tempHome();
  mkdirSync(join(home.dir, "skills", "wiki"), { recursive: true });
  writeFileSync(
    join(home.dir, "skills", "wiki", "SKILL.md"),
    `---\nname: wiki\ndescription: "Wiki rules."\n---\n\n${WIKI_BODY}\n`,
  );
  const core = await startCore({ home: home.dir, port: 0, schedule: false });
  const tokens = JSON.parse(readFileSync(join(home.dir, "tokens.json"), "utf8")) as Record<string, string>;
  const clients: Client[] = [];
  t.after(async () => {
    for (const c of clients) await c.close();
    await core.close();
    home.cleanup();
  });
  const connect = async (as: string): Promise<Client> => {
    const transport = new StreamableHTTPClientTransport(new URL(`${core.url}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${tokens[as]}` } },
    });
    const client = new Client({ name: "test", version: "0.0.0" });
    await client.connect(transport);
    clients.push(client);
    return client;
  };
  return { home, core, tokens, connect };
}

const textOf = (r: unknown): string => {
  const first = (r as CallToolResult).content[0];
  return first && first.type === "text" ? first.text : "";
};

test("SC21: lounge_skill with an unknown name returns the error unknown skill", async (t) => {
  const h = await boot(t);
  const client = await h.connect("owner");
  for (const name of ["nothing", "../wiki", "Wiki", ""]) {
    const res = (await client.callTool({ name: "lounge_skill", arguments: { name } })) as CallToolResult;
    assert.equal(res.isError, true, name);
    assert.match(textOf(res), /unknown skill/, name);
  }
});

test("SC21: lounge_skill with a known name returns the body as plain text, for an agent token too", async (t) => {
  const h = await boot(t);
  for (const as of ["owner", "ada"]) {
    const client = await h.connect(as);
    const res = (await client.callTool({ name: "lounge_skill", arguments: { name: "wiki" } })) as CallToolResult;
    assert.equal(res.isError, undefined, textOf(res));
    assert.equal(textOf(res).trim(), WIKI_BODY);
  }
});

test("the MCP registry loads each module of mcp/tools at start, so a new tool needs no edit of server.ts", async (t) => {
  assert.ok(TOOL_MODULES.some((m) => m.name === "lounge_skill"));
  const names = TOOL_MODULES.map((m) => m.name);
  assert.deepEqual(names, [...new Set(names)], "tool names are unique");
  const h = await boot(t);
  const client = await h.connect("owner");
  const listed = (await client.listTools()).tools.map((x) => x.name);
  for (const name of names) assert.ok(listed.includes(name), `${name} is listed`);
});

test("lounge_skill follows the chat grant: it is an allowed runtime tool, and off with the group", (t) => {
  const home = tempHome();
  const db = openDb(join(home.dir, "lounge.db"));
  t.after(() => {
    db.close();
    home.cleanup();
  });
  assert.equal(can({ caller: "ada", restricted: true }, "lounge_skill"), true);
  const grants = new Grants(db);
  assert.ok(grants.runtimeTools("ada").includes("mcp__lounge__lounge_skill"));
  assert.equal(grants.allows("ada", "lounge_skill"), true);
  grants.set("ada", { chat: false });
  assert.equal(grants.allows("ada", "lounge_skill"), false);
  assert.ok(!grants.runtimeTools("ada").includes("mcp__lounge__lounge_skill"));
});
