import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { startCore } from "../src/api/http.ts";
import { coreKinds } from "../src/adapters/runtimes.ts";
import { replyAdapter } from "../src/adapters/stub.ts";
import type { Adapter, ChatTurnInput, ChatTurnResult } from "../src/adapters/types.ts";
import { defaultConfig, SEED_AGENTS } from "../src/config.ts";
import { openDb } from "../src/db/db.ts";
import { mentions } from "../src/scheduler/scheduler.ts";
import { Roster } from "../src/roster/roster.ts";
import { PLUGINS_MARK, migrateRuntimes } from "../src/roster/migrate.ts";
import { readSetting } from "../src/db/settings.ts";
import { seedDrift } from "../src/roster/seed.ts";
import type { AgentEntry, RuntimeKind } from "../src/roster/types.ts";
import { DatabaseSync } from "node:sqlite";
import { WebSocket } from "ws";
import { tempHome, testKinds } from "./helpers.ts";

interface View extends AgentEntry {
  efforts: string[];
  models: string[];
}

interface Boot {
  home: string;
  url: string;
  tokens(): Record<string, string>;
  api(path: string, init?: RequestInit & { as?: string | null }): Promise<Response>;
  json<T>(res: Response): Promise<T>;
  list(): Promise<View[]>;
  say(text: string): Promise<void>;
  texts(author: string): Promise<string[]>;
  waitFor(check: () => Promise<boolean>, what: string): Promise<void>;
  restart(): Promise<void>;
}

const EFFORTS = ["low", "medium", "high", "xhigh", "max"];

// A stand-in for a CLI runtime plugin. Tool modes work on the claude-code kind only.
function cli(id: string, label: string, toolModes: boolean): RuntimeKind {
  return {
    id,
    label,
    efforts: () => [...EFFORTS],
    models: () => ["opus", "sonnet"],
    create: () => replyAdapter(id, ""),
    ...(toolModes ? { toolModes: true } : {}),
  };
}

const CLI_KINDS = [cli("claude-code", "Claude Code", true), cli("codex", "Codex", false)];

// Ada and cyd are off.
// Nana is then the only agent who can answer.
const QUIET = { adapters: { ada: { enabled: false }, cyd: { enabled: false } }, scheduler: { replyDelayMs: 0 } };

async function boot(
  t: TestContext,
  opts: { config?: object; runtimes?: RuntimeKind[]; schedule?: boolean } = {},
): Promise<Boot> {
  const home = tempHome();
  if (opts.config) writeFileSync(join(home.dir, "config.json"), JSON.stringify(opts.config));
  const runtimes = [...CLI_KINDS, ...(opts.runtimes ?? [])];
  let core = await startCore({
    home: home.dir,
    port: 0,
    schedule: opts.schedule ?? false,
    runtimes,
  });
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
  const json = async <T>(res: Response): Promise<T> => (await res.json()) as T;
  const list = async () => (await json<{ agents: View[] }>(await api("/api/agents"))).agents;
  const texts = async (author: string) => {
    const messages = await json<{ author: string; text: string }[]>(await api("/api/rooms/lounge/messages?limit=200"));
    return messages.filter((m) => m.author === author).map((m) => m.text);
  };
  const waitFor = async (check: () => Promise<boolean>, what: string) => {
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      if (await check()) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.fail(`timed out: ${what}`);
  };
  return {
    home: home.dir,
    get url() {
      return core.url;
    },
    tokens,
    api,
    json,
    list,
    texts,
    waitFor,
    async say(text) {
      const res = await api("/api/rooms/lounge/messages", { method: "POST", body: JSON.stringify({ text }) });
      assert.equal(res.status, 201);
    },
    async restart() {
      await core.close();
      core = await startCore({ home: home.dir, port: 0, schedule: opts.schedule ?? false, runtimes });
    },
  };
}

function post(h: Boot, body: unknown, as?: string | null): Promise<Response> {
  return h.api("/api/agents", { method: "POST", body: JSON.stringify(body), as });
}

function patch(h: Boot, id: string, body: unknown, as?: string | null): Promise<Response> {
  return h.api(`/api/agents/${id}`, { method: "PATCH", body: JSON.stringify(body), as });
}

// Records its briefs and replies at once.
function capture(briefs: string[]): RuntimeKind {
  return {
    id: "capture",
    label: "Capture",
    efforts: () => [],
    models: () => [],
    create: () => ({
      name: "capture",
      available: async () => ({ ok: true }),
      chatTurn: async (input: ChatTurnInput): Promise<ChatTurnResult> => {
        briefs.push(input.brief);
        return { kind: "post", text: "captured" };
      },
    }),
  };
}

// Never answers until the turn aborts.
function hang(seen: { token?: string; aborted: boolean }): RuntimeKind {
  return {
    id: "hang",
    label: "Hang",
    efforts: () => [],
    models: () => [],
    create: (): Adapter => ({
      name: "hang",
      available: async () => ({ ok: true }),
      chatTurn: (input, signal) =>
        new Promise<ChatTurnResult>((_resolve, reject) => {
          seen.token = input.mcpToken;
          signal.addEventListener(
            "abort",
            () => {
              seen.aborted = true;
              reject(new Error("aborted"));
            },
            { once: true },
          );
        }),
    }),
  };
}

const INIT = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "roster-test", version: "0" } },
};

function mcpInit(h: Boot, token: string): Promise<Response> {
  return fetch(`${h.url}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify(INIT),
  });
}

async function mcpClient(h: Boot, token: string, clients: Client[]): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(`${h.url}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: "roster-test", version: "0.0.0" });
  await client.connect(transport);
  clients.push(client);
  return client;
}

function body(result: unknown): string {
  const content = (result as CallToolResult).content[0];
  return content && content.type === "text" ? content.text : "";
}

const kindsWithModes = () => [...coreKinds(), ...CLI_KINDS];

test("roster seed: a first start seeds the four rows from config.json and the defaults", () => {
  const home = tempHome();
  const db = openDb(join(home.dir, "lounge.db"));
  try {
    const roster = new Roster(db, defaultConfig().adapters, testKinds);
    const rows = roster.active();
    assert.deepEqual(
      rows.map((e) => [e.id, e.runtime, e.enabled, e.tape, e.position]),
      [
        ["ada", "claude-code", true, 1, 0],
        ["bea", "codex", false, 2, 1],
        ["cyd", "claude-code", true, 3, 2],
        ["dee", "codex", false, 4, 3],
      ],
    );
    assert.deepEqual(rows.map((e) => e.options), [
      { command: "claude", commandArgs: [], softMs: 60_000, hardMs: 180_000 },
      { command: "codex", commandArgs: [], softMs: 60_000, hardMs: 180_000 },
      { command: "claude", commandArgs: [], softMs: 180_000, hardMs: 600_000 },
      { command: "codex", commandArgs: [], softMs: 60_000, hardMs: 240_000 },
    ]);
    for (const e of rows) assert.deepEqual([e.model, e.effort, e.retired], ["", "", false]);
    assert.deepEqual(SEED_AGENTS, rows.map((e) => e.id));
  } finally {
    db.close();
    home.cleanup();
  }
});

test("roster seed: a config.json value overrides the default", () => {
  const home = tempHome();
  const db = openDb(join(home.dir, "lounge.db"));
  try {
    const config = defaultConfig();
    config.adapters.dee = { enabled: true, command: "my-codex", commandArgs: ["-x"], softMs: 7 };
    config.adapters.cyd = { enabled: false, command: "my-claude" };
    const roster = new Roster(db, config.adapters, testKinds);
    assert.deepEqual(roster.get("dee")?.options, { command: "my-codex", commandArgs: ["-x"], softMs: 7, hardMs: 240_000 });
    assert.equal(roster.get("dee")?.enabled, true);
    assert.deepEqual(roster.get("cyd")?.options, { command: "my-claude", commandArgs: [], softMs: 180_000, hardMs: 600_000 });
    assert.equal(roster.get("cyd")?.enabled, false);
  } finally {
    db.close();
    home.cleanup();
  }
});

test("roster seed: a second start does not reseed or overwrite an edited row", async (t) => {
  const h = await boot(t);
  const first = await h.list();
  assert.deepEqual(first.map((e) => e.id), ["ada", "bea", "cyd", "dee"]);
  assert.deepEqual(first[0]!.efforts, EFFORTS);
  const res = await patch(h, "ada", { model: "opus", effort: "high", enabled: false, tape: 4 });
  assert.equal(res.status, 200);
  const created = await post(h, { id: "nana", runtime: "stub" });
  assert.equal(created.status, 201);

  await h.restart();
  const second = await h.list();
  assert.deepEqual(second.map((e) => e.id), ["ada", "bea", "cyd", "dee", "nana"]);
  const ada = second.find((e) => e.id === "ada")!;
  assert.deepEqual([ada.model, ada.effort, ada.enabled, ada.tape], ["opus", "high", false, 4]);
});

test("roster seed: tokens.json holds one token per active agent and owner", async (t) => {
  const h = await boot(t);
  assert.deepEqual(Object.keys(h.tokens()).sort(), ["ada", "bea", "cyd", "dee", "owner"]);
});

test("roster: add, mention, reply, and retire an agent", async (t) => {
  const seen = { aborted: false } as { token?: string; aborted: boolean };
  const h = await boot(t, { config: QUIET, schedule: true, runtimes: [hang(seen)] });

  const created = await post(h, { id: "nana", runtime: "stub", options: { reply: "nya from nana" } });
  assert.equal(created.status, 201);
  const entry = await h.json<View>(created);
  assert.deepEqual([entry.id, entry.runtime, entry.enabled, entry.retired], ["nana", "stub", true, false]);
  assert.equal(entry.tape, 1, "the fifth agent gets position % 4 + 1");

  // A token and a closed grant row.
  const token = h.tokens()["nana"];
  assert.ok(token);
  const grants = await h.json<{ grants: Record<string, Record<string, boolean>> }>(await h.api("/api/grants"));
  assert.ok(Object.values(grants.grants["nana"]!).every((on) => !on));
  assert.ok(Object.values(grants.grants["ada"]!).every((on) => on));

  // The new token authenticates /mcp as nana.
  assert.equal((await mcpInit(h, token!)).status, 200);
  const clients: Client[] = [];
  t.after(async () => {
    for (const client of clients) await client.close().catch(() => {});
  });
  const nana = await mcpClient(h, token!, clients);
  const denied = body(await nana.callTool({ name: "session_list", arguments: {} }));
  assert.match(denied, /forbidden: nana may not use session_list/);

  // A mention makes it post its stub reply.
  await h.say("@nana are you there?");
  await h.waitFor(async () => (await h.texts("nana")).includes("nya from nana"), "nana reply");

  // A chat session: the stub answers, then idles.
  const owner = await mcpClient(h, h.tokens()["owner"]!, clients);
  const opened = JSON.parse(
    body(await owner.callTool({ name: "session_open", arguments: { agent: "nana", kind: "chat", brief: "hi" } })),
  ) as { id: string };
  await h.waitFor(
    async () => JSON.parse(body(await owner.callTool({ name: "session_status", arguments: { id: opened.id } }))).state === "idle",
    "session idle",
  );

  // Switch it to the hang runtime,
  // so a turn runs when it is retired.
  assert.equal((await patch(h, "nana", { runtime: "hang", options: {} })).status, 200);
  await h.say("@nana please work");
  await h.waitFor(async () => seen.token !== undefined, "hang turn started");
  assert.equal((await mcpInit(h, seen.token!)).status, 200, "its turn token works before");

  const gone = await h.api("/api/agents/nana", { method: "DELETE" });
  assert.equal(gone.status, 204);
  assert.equal(seen.aborted, true, "its running turn aborted");
  assert.equal((await mcpInit(h, token!)).status, 401, "its token is revoked");
  assert.equal((await mcpInit(h, seen.token!)).status, 401, "its turn token is revoked");
  assert.equal(h.tokens()["nana"], undefined);
  const status = JSON.parse(body(await owner.callTool({ name: "session_status", arguments: { id: opened.id } }))) as {
    state: string;
    reason?: string;
  };
  assert.deepEqual([status.state, status.reason], ["closed", "retired"]);

  // The scheduler skips it. Old messages stay.
  // A turn it tried for it would log a failure.
  await new Promise((resolve) => setTimeout(resolve, 150));
  const lines: string[] = [];
  const log = console.log;
  console.log = (...args: unknown[]) => void lines.push(args.join(" "));
  try {
    await h.say("@nana come back");
    await h.say("anyone here?");
    await new Promise((resolve) => setTimeout(resolve, 400));
  } finally {
    console.log = log;
  }
  assert.deepEqual(lines.filter((line) => line.includes("nana")), []);
  assert.ok((await h.texts("nana")).includes("nya from nana"), "old messages keep the author");
  assert.equal((await h.list()).some((e) => e.id === "nana"), false);
  const who = await h.json<{ caller: string }[]>(await h.api("/api/who"));
  assert.equal(who.some((p) => p.caller === "nana"), false);
});

test("roster: a mention needs the whole id, so @nana-chan does not wake nana", async (t) => {
  const briefs: string[] = [];
  const h = await boot(t, { config: QUIET, schedule: true, runtimes: [capture(briefs)] });
  assert.equal((await post(h, { id: "nana", runtime: "capture" })).status, 201);

  await h.say("@nana-chan hello");
  await h.waitFor(async () => briefs.length === 1, "fallback lead turn");
  assert.match(briefs[0]!, /^The owner wrote in /, "no mention reached the agent");

  await h.say("@nana hello");
  await h.waitFor(async () => briefs.length === 2, "mentioned turn");
  assert.match(briefs[1]!, /^The owner mentioned you in /);
});

test("mentions: ids match whole, longest first, in any case", () => {
  const ids = ["nana", "nana-b", "cyd"];
  assert.deepEqual(mentions("@nana-chan", ids), []);
  assert.deepEqual(mentions("@nana-b and @NANA, @cyd.", ids), ["nana-b", "nana", "cyd"]);
  assert.deepEqual(mentions("@nana2 @nana- @nana_x", ids), []);
  assert.deepEqual(mentions("@nana", []), []);
});

test("roster validation: a bad input gets 400 and leaves the roster alone", async (t) => {
  const h = await boot(t);
  const before = (await h.list()).map((e) => e.id);
  const long = "a".repeat(25);
  const inputs: unknown[] = [
    { id: "owner", runtime: "stub" },
    { id: "constructor", runtime: "stub" },
    { id: "prototype", runtime: "stub" },
    { id: "__proto__", runtime: "stub" },
    { id: "Nana", runtime: "stub" },
    { id: "n", runtime: "stub" },
    { id: "a b", runtime: "stub" },
    { id: "../x", runtime: "stub" },
    { id: long, runtime: "stub" },
    { id: "1nana", runtime: "stub" },
    { id: "ada", runtime: "stub" },
    { id: "nana", runtime: "no-such-runtime" },
    { id: "nana", runtime: "stub", effort: "high" },
    { id: "nana", runtime: "claude-code", effort: "turbo" },
    { id: "nana", runtime: "stub", tape: 0 },
    { id: "nana", runtime: "stub", tape: 5 },
    { id: "nana", runtime: "stub", tape: 2.5 },
    { id: "nana", runtime: "stub", tape: "1" },
    { id: "nana", runtime: "stub", enabled: "yes" },
    { id: "nana", runtime: "stub", options: { softMs: -1 } },
    { id: "nana", runtime: "stub", extra: 1 },
    { id: "nana", runtime: "claude-code", model: "-rf" },
    { id: "nana", runtime: "claude-code", model: "opus" + String.fromCharCode(10) + "sonnet" },
    { id: "nana", runtime: "claude-code", model: "x".repeat(201) },
    { id: "nana", runtime: "stub", displayName: 5 },
  ];
  for (const input of inputs) {
    const res = await post(h, input);
    assert.equal(res.status, 400, JSON.stringify(input));
  }
  assert.equal((await post(h, [1])).status, 400);
  assert.deepEqual((await h.list()).map((e) => e.id), before);
  assert.deepEqual(Object.keys(h.tokens()).sort(), ["ada", "bea", "cyd", "dee", "owner"]);
});

test("roster validation: a retired id stays taken", async (t) => {
  const h = await boot(t);
  assert.equal((await post(h, { id: "nana", runtime: "stub" })).status, 201);
  assert.equal((await post(h, { id: "nana", runtime: "stub" })).status, 400, "duplicate");
  assert.equal((await h.api("/api/agents/nana", { method: "DELETE" })).status, 204);
  assert.equal((await post(h, { id: "nana", runtime: "stub" })).status, 400, "retired id");
  assert.equal((await patch(h, "nana", { enabled: false })).status, 404, "a retired agent cannot change");
  assert.equal((await h.api("/api/agents/nana", { method: "DELETE" })).status, 404);
});

test("roster validation: every PATCH checks the merged entry", async (t) => {
  const h = await boot(t);
  assert.equal((await post(h, { id: "mika", runtime: "claude-code", model: "opus", effort: "high" })).status, 201);
  const mika = () => h.list().then((list) => list.find((e) => e.id === "mika")!);

  // The runtime change makes the saved effort invalid.
  assert.equal((await patch(h, "mika", { runtime: "stub" })).status, 400);
  assert.equal((await patch(h, "mika", { effort: "turbo" })).status, 400);
  assert.equal((await patch(h, "mika", { runtime: "nope" })).status, 400);
  assert.equal((await patch(h, "mika", { tape: 5 })).status, 400);
  assert.equal((await patch(h, "mika", { tape: 0 })).status, 400);
  assert.equal((await patch(h, "mika", { id: "other" })).status, 400);
  assert.equal((await patch(h, "mika", { position: -1 })).status, 400);
  assert.equal((await patch(h, "mika", { options: [] })).status, 400);
  const same = await mika();
  assert.deepEqual([same.runtime, same.model, same.effort, same.tape], ["claude-code", "opus", "high", 1]);

  // A valid change and its effort together work.
  assert.equal((await patch(h, "mika", { runtime: "stub", effort: "" })).status, 200);
  assert.equal((await patch(h, "mika", { effort: "high" })).status, 400);
  assert.equal((await patch(h, "nobody", { enabled: false })).status, 404);
});

test("roster api: every route needs the owner token", async (t) => {
  const h = await boot(t);
  const routes: [string, string, unknown][] = [
    ["GET", "/api/agents", undefined],
    ["POST", "/api/agents", { id: "nana", runtime: "stub" }],
    ["PATCH", "/api/agents/ada", { enabled: false }],
    ["DELETE", "/api/agents/ada", undefined],
    ["GET", "/api/runtimes/claude-code/efforts", undefined],
  ];
  for (const [method, path, payload] of routes) {
    const init = { method, ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) };
    assert.equal((await h.api(path, { ...init, as: "ada" })).status, 403, `${method} ${path} as ada`);
    assert.equal((await h.api(path, { ...init, as: null })).status, 401, `${method} ${path} without a token`);
  }
  assert.deepEqual((await h.list()).map((e) => e.id), ["ada", "bea", "cyd", "dee"]);
  assert.equal(h.tokens()["ada"] !== undefined, true);
});

test("roster api: the effort route follows the merged draft", async (t) => {
  const h = await boot(t);
  const ask = async (id: string, entry?: unknown) => {
    const query = entry === undefined ? "" : `?entry=${encodeURIComponent(JSON.stringify(entry))}`;
    const res = await h.api(`/api/runtimes/${id}/efforts${query}`);
    return { status: res.status, body: await res.json() as { efforts: string[]; models: string[] } };
  };
  const claude = await ask("claude-code", { model: "opus" });
  assert.equal(claude.status, 200);
  assert.deepEqual(claude.body.efforts, EFFORTS);
  assert.ok(claude.body.models.includes("opus"));
  const stub = await ask("stub");
  assert.deepEqual([stub.body.efforts, stub.body.models], [[], []]);
  assert.equal((await ask("nope")).status, 404);
  assert.equal((await h.api("/api/runtimes/stub/efforts?entry=%5B1%5D")).status, 400);
  const listed = await h.json<{ runtimes: { id: string }[] }>(await h.api("/api/agents"));
  assert.deepEqual(listed.runtimes.map((r) => r.id), ["stub", "claude-code", "codex"]);
});

test("roster: a display name goes to the nicknames and defaults to none", async (t) => {
  const h = await boot(t);
  assert.equal((await post(h, { id: "nana", runtime: "stub", displayName: "Nana-sama" })).status, 201);
  assert.equal((await post(h, { id: "mika", runtime: "stub" })).status, 201);
  const who = await h.json<{ caller: string; nickname?: string }[]>(await h.api("/api/who"));
  assert.equal(who.find((p) => p.caller === "nana")?.nickname, "Nana-sama");
  assert.equal(who.find((p) => p.caller === "mika")?.nickname, undefined);
});

test("roster hot change: the next reply uses the new stub text without a restart", async (t) => {
  const h = await boot(t, { config: QUIET, schedule: true });
  assert.equal((await post(h, { id: "nana", runtime: "stub", options: { reply: "first text" } })).status, 201);
  await h.say("@nana one");
  await h.waitFor(async () => (await h.texts("nana")).includes("first text"), "first reply");

  const res = await patch(h, "nana", { options: { reply: "second text" } });
  assert.equal(res.status, 200);
  assert.equal((await h.json<View>(res)).options.reply, "second text");
  await h.say("@nana two");
  await h.waitFor(async () => (await h.texts("nana")).includes("second text"), "second reply");
  assert.deepEqual(await h.texts("nana"), ["first text", "second text"]);
});

test("roster: an empty stub reply passes", async (t) => {
  const h = await boot(t, { config: QUIET, schedule: true });
  assert.equal((await post(h, { id: "nana", runtime: "stub" })).status, 201);
  await h.say("@nana hello");
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.deepEqual(await h.texts("nana"), []);
});

test("roster: a new agent leads a work thread and answers in it", async (t) => {
  const h = await boot(t, { config: QUIET });
  assert.equal((await post(h, { id: "nana", runtime: "stub", options: { reply: "on it" } })).status, 201);
  const bad = await h.api("/api/threads", {
    method: "POST",
    body: JSON.stringify({ channel: "lounge", title: "x", brief: "y", lead: "ghost" }),
  });
  assert.equal(bad.status, 400);
  const res = await h.api("/api/threads", {
    method: "POST",
    body: JSON.stringify({ channel: "lounge", title: "Tidy up", brief: "Tidy the folder.", lead: "nana" }),
  });
  assert.equal(res.status, 201);
  const info = await h.json<{ id: string; lead: string }>(res);
  assert.equal(info.lead, "nana");
  await h.waitFor(async () => {
    const list = await h.json<{ author: string; text: string }[]>(await h.api(`/api/rooms/${info.id}/messages`));
    return list.some((m) => m.author === "nana" && m.text === "on it");
  }, "thread reply");
});

test("roster: a new agent is probed, and a retired one leaves the probe", async () => {
  const { Reachability } = await import("../src/lounge/reachability.ts");
  const home = tempHome();
  const db = openDb(join(home.dir, "lounge.db"));
  try {
    const config = defaultConfig();
    config.adapters.ada.enabled = false;
    config.adapters.cyd.enabled = false;
    const roster = new Roster(db, config.adapters, testKinds);
    const pool = {
      get: (id: string): Adapter | undefined =>
        roster.has(id)
          ? { name: "t", available: async () => ({ ok: true }), chatTurn: async () => ({ kind: "pass" as const }) }
          : undefined,
    };
    const reach = new Reachability({ adapters: pool, roster, intervalMs: 1000 });
    await reach.probe();
    assert.deepEqual([...reach.reachable()], []);
    roster.add({ id: "nana", runtime: "stub" });
    await reach.probe();
    assert.deepEqual([...reach.reachable()], ["nana"]);
    roster.retire("nana");
    await reach.probe();
    assert.deepEqual([...reach.reachable()], []);
  } finally {
    db.close();
    home.cleanup();
  }
});

test("roster: the id constructor is refused and the api keeps working", async (t) => {
  const h = await boot(t);
  for (const id of ["constructor", "prototype", "__proto__"]) {
    assert.equal((await post(h, { id, runtime: "stub" })).status, 400, id);
  }
  assert.equal((await h.api("/api/who")).status, 200);
  assert.equal((await h.api("/api/agents/constructor", { method: "DELETE" })).status, 404);
  assert.equal(Object.hasOwn(h.tokens(), "constructor"), false);
  assert.equal((await h.api("/api/who")).status, 200);
});

test("roster: a runtime change drops the options of the old runtime", async (t) => {
  const h = await boot(t);
  const bea = () => h.list().then((list) => list.find((e) => e.id === "bea")!);
  assert.equal((await bea()).options.command, "codex");

  // The runtime stays: the options stay.
  assert.equal((await patch(h, "bea", { model: "", enabled: true })).status, 200);
  assert.equal((await bea()).options.command, "codex");

  // The runtime changes and no options come: the old ones go.
  assert.equal((await patch(h, "bea", { runtime: "claude-code" })).status, 200);
  assert.deepEqual((await bea()).options, {});

  // The runtime changes and options come: the given ones win.
  assert.equal((await patch(h, "bea", { runtime: "codex", options: { command: "mycodex" } })).status, 200);
  assert.deepEqual((await bea()).options, { command: "mycodex" });

  // Options that no runtime owns stay.
  assert.equal((await patch(h, "bea", { options: { command: "mycodex", note: "kept" } })).status, 200);
  assert.equal((await patch(h, "bea", { runtime: "claude-code" })).status, 200);
  assert.deepEqual((await bea()).options, { note: "kept" });

  // A runtime that nothing loads cannot be chosen.
  assert.equal((await patch(h, "bea", { runtime: "nope" })).status, 400);
});

test("roster: a model is trimmed", async (t) => {
  const h = await boot(t);
  const made = await post(h, { id: "nana", runtime: "claude-code", model: "  opus  " });
  assert.equal((await h.json<View>(made)).model, "opus");
  const changed = await patch(h, "nana", { model: " sonnet" + String.fromCharCode(9) });
  assert.equal((await h.json<View>(changed)).model, "sonnet");
});

test("roster: the retired list keeps a tape for old messages", async (t) => {
  const h = await boot(t);
  assert.equal((await post(h, { id: "nana", runtime: "stub", tape: 3 })).status, 201);
  assert.equal((await h.api("/api/agents/nana", { method: "DELETE" })).status, 204);
  const body = await h.json<{ agents: View[]; retired: AgentEntry[] }>(await h.api("/api/agents"));
  assert.equal(body.agents.some((e) => e.id === "nana"), false);
  assert.deepEqual(body.retired.map((e) => [e.id, e.tape, e.retired]), [["nana", 3, true]]);
});

test("roster: one failed retire step skips no other", async (t) => {
  const seen = { aborted: false } as { token?: string; aborted: boolean };
  const h = await boot(t, { config: QUIET, schedule: true, runtimes: [hang(seen)] });
  assert.equal((await post(h, { id: "nana", runtime: "hang" })).status, 201);
  const owner = h.tokens()["owner"]!;
  const token = h.tokens()["nana"]!;
  await h.say("@nana please work");
  await h.waitFor(async () => seen.token !== undefined, "hang turn started");
  // A folder where the token file belongs: the file write fails.
  rmSync(join(h.home, "tokens.json"));
  mkdirSync(join(h.home, "tokens.json"));
  const gone = await fetch(`${h.url}/api/agents/nana`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${owner}` },
  });
  assert.equal(gone.status, 204);
  assert.equal(seen.aborted, true, "its turn still aborted");
  assert.equal((await mcpInit(h, seen.token!)).status, 401, "its turn token still revoked");
  assert.equal((await mcpInit(h, token)).status, 401, "its token is gone from memory");
});

test("roster: a config.json adapters value that differs from the row is reported", () => {
  const home = tempHome();
  const db = openDb(join(home.dir, "lounge.db"));
  try {
    const config = defaultConfig();
    const roster = new Roster(db, config.adapters, testKinds);
    assert.deepEqual(seedDrift(roster, config.adapters), [], "a fresh seed has no drift");
    config.adapters.ada.command = "other-claude";
    config.adapters.dee.enabled = true;
    const lines = seedDrift(roster, config.adapters);
    assert.equal(lines.length, 2);
    assert.match(lines[0]!, /adapters\.ada differs/);
    assert.match(lines[0]!, /PATCH \/api\/agents\/ada/);
    assert.match(lines[1]!, /adapters\.dee differs/);
    roster.update("ada", { options: { command: "other-claude", commandArgs: [], softMs: 60_000, hardMs: 180_000 } });
    assert.equal(seedDrift(roster, config.adapters).length, 1, "equal values do not report, whatever the key order");
    roster.retire("dee");
    assert.deepEqual(seedDrift(roster, config.adapters), [], "a retired row is skipped");
  } finally {
    db.close();
    home.cleanup();
  }
});

// ---- runtime migration ----

test("migration: the plugins that rows use are enabled once", (t) => {
  const home = tempHome();
  const db = openDb(join(home.dir, "lounge.db"));
  t.after(() => {
    db.close();
    home.cleanup();
  });
  const roster = new Roster(db, defaultConfig().adapters, testKinds);
  const enabled: string[][] = [];
  const deps = { db, roster, enablePlugins: (ids: string[]) => enabled.push(ids), log: () => {} };
  migrateRuntimes(deps);
  assert.deepEqual(enabled, [["claude-code", "codex"]]);
  assert.equal(readSetting(db, PLUGINS_MARK), "1");
  migrateRuntimes(deps);
  assert.equal(enabled.length, 1, "the row applies once");
});

test("migration: a failing row writes no setting and logs the failure", (t) => {
  const home = tempHome();
  const db = openDb(join(home.dir, "lounge.db"));
  t.after(() => {
    db.close();
    home.cleanup();
  });
  const cyd = { id: "cyd", runtime: "claude-code", retired: false } as AgentEntry;
  const logs: string[] = [];
  migrateRuntimes({
    db,
    roster: { active: () => [cyd] },
    enablePlugins: () => {
      throw new Error("boom");
    },
    log: (line) => logs.push(line),
  });
  assert.equal(readSetting(db, PLUGINS_MARK), undefined, "a rolled back row leaves no setting");
  assert.ok(logs.some((l) => /migration failed: boom/.test(l)));
});

const OLD_AGENTS = `CREATE TABLE agents (
  id TEXT PRIMARY KEY, runtime TEXT NOT NULL, model TEXT NOT NULL DEFAULT '', effort TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1, tape INTEGER NOT NULL, options TEXT NOT NULL DEFAULT '{}',
  position INTEGER NOT NULL, retired_at TEXT)`;

test("tool mode: a seed row is full, and an older database reads a NULL tool_mode as full", (t) => {
  const home = tempHome();
  t.after(() => home.cleanup());
  const file = join(home.dir, "lounge.db");
  const old = new DatabaseSync(file);
  old.exec(OLD_AGENTS);
  old.prepare("INSERT INTO agents (id, runtime, tape, position) VALUES ('oldie', 'stub', 1, 0)").run();
  old.close();
  const db = openDb(file);
  try {
    const roster = new Roster(db, defaultConfig().adapters, kindsWithModes);
    assert.equal(roster.get("oldie")?.toolMode, "full");
    assert.equal(db.prepare("SELECT tool_mode FROM agents WHERE id = 'oldie'").get()?.tool_mode, null);
  } finally {
    db.close();
  }
  const fresh = openDb(join(home.dir, "fresh.db"));
  try {
    const roster = new Roster(fresh, defaultConfig().adapters, kindsWithModes);
    assert.deepEqual(roster.active().map((e) => e.toolMode), ["full", "full", "full", "full"]);
    fresh.exec("UPDATE agents SET tool_mode = NULL");
    assert.equal(roster.get("ada")?.toolMode, "full");
    fresh.exec("UPDATE agents SET tool_mode = 'bogus' WHERE id = 'bea'");
    assert.equal(roster.get("bea")?.toolMode, "full", "an unknown value reads full on a kind without support");
    roster.add({ id: "nana", runtime: "claude-code" });
    fresh.exec("UPDATE agents SET tool_mode = 'bogus' WHERE id = 'nana'");
    assert.equal(roster.get("nana")?.toolMode, "ask", "an unknown value asks on a kind with support");
    assert.equal(roster.active().find((e) => e.id === "nana")?.toolMode, "ask");
    roster.update("ada", { model: "opus" });
    assert.equal(roster.get("ada")?.toolMode, "full", "a PATCH on that row is not refused");
  } finally {
    fresh.close();
  }
});

test("tool mode: add defaults to ask on a runtime with mode support, full on stub", async (t) => {
  const h = await boot(t);
  const cliAgent = await h.json<View>(await post(h, { id: "nana", runtime: "claude-code" }));
  assert.equal(cliAgent.toolMode, "ask");
  const stub = await h.json<View>(await post(h, { id: "kiki", runtime: "stub" }));
  assert.equal(stub.toolMode, "full");
  const listed = await h.list();
  assert.deepEqual(
    listed.map((e) => [e.id, e.toolMode]),
    [["ada", "full"], ["bea", "full"], ["cyd", "full"], ["dee", "full"], ["nana", "ask"], ["kiki", "full"]],
  );
  const chosen = await h.json<View>(await post(h, { id: "lulu", runtime: "claude-code", toolMode: "read-only" }));
  assert.equal(chosen.toolMode, "read-only");
  assert.equal((await post(h, { id: "mimi", runtime: "stub", toolMode: "auto" })).status, 400);
});

test("tool mode: PATCH stores a mode, and a bad value or an unsupported runtime gets bad_agent", async (t) => {
  const h = await boot(t);
  await post(h, { id: "nana", runtime: "claude-code" });
  await post(h, { id: "kiki", runtime: "stub" });
  const ok = await patch(h, "nana", { toolMode: "auto" });
  assert.equal(ok.status, 200);
  assert.equal((await h.list()).find((e) => e.id === "nana")!.toolMode, "auto");
  await h.restart();
  assert.equal((await h.list()).find((e) => e.id === "nana")!.toolMode, "auto", "the mode survives a restart");

  for (const value of ["yolo", "", 7, null, "AUTO"]) {
    const res = await patch(h, "nana", { toolMode: value });
    assert.equal(res.status, 400, String(value));
    assert.equal((await h.json<{ error: string }>(res)).error, "bad_agent");
  }
  const refused = await patch(h, "kiki", { toolMode: "ask" });
  assert.equal(refused.status, 400);
  assert.equal((await h.json<{ error: string }>(refused)).error, "bad_agent");
  assert.equal((await patch(h, "kiki", { toolMode: "full" })).status, 200);
  assert.equal((await patch(h, "ada", { toolMode: "ask" })).status, 200, "the claude-code kind supports modes");
  assert.equal((await patch(h, "bea", { toolMode: "auto" })).status, 400, "this codex kind ignores modes");
  assert.equal((await h.list()).find((e) => e.id === "nana")!.toolMode, "auto", "a refused patch changes nothing");
});

test("tool mode: the runtime list tells the UI which kinds support modes", async (t) => {
  const h = await boot(t);
  const res = await h.json<{ runtimes: { id: string; toolModes: boolean }[] }>(await h.api("/api/agents"));
  const flags = Object.fromEntries(res.runtimes.map((r) => [r.id, r.toolModes]));
  assert.equal(flags["claude-code"], true);
  assert.equal(flags["stub"], false);
  assert.equal(flags["codex"], false);
});

test("tool mode: a runtime change to a kind without mode support resets the mode to full", async (t) => {
  const h = await boot(t);
  await post(h, { id: "nana", runtime: "claude-code", toolMode: "auto" });
  const moved = await h.json<View>(await patch(h, "nana", { runtime: "stub" }));
  assert.equal(moved.toolMode, "full");
  assert.equal((await h.list()).find((e) => e.id === "nana")!.toolMode, "full");
  const back = await h.json<View>(await patch(h, "nana", { runtime: "claude-code" }));
  assert.equal(back.toolMode, "full", "a move to a kind with support keeps the mode");
  await patch(h, "nana", { toolMode: "read-only" });
  const kept = await h.json<View>(await patch(h, "nana", { runtime: "claude-code" }));
  assert.equal(kept.toolMode, "read-only");
  assert.equal((await patch(h, "nana", { runtime: "stub", toolMode: "ask" })).status, 400);
});

interface Seen {
  type: string;
  entry?: { outcome: string; verdict: string; source: string; tool: string };
}

const CHECK_CWD = "E:\\projects\\x";

test("tool mode: the next guard check uses the new mode with no restart", async (t) => {
  const h = await boot(t);
  await post(h, { id: "nana", runtime: "claude-code" });
  const check = (as: string) =>
    h.api("/guard/check", { method: "POST", body: JSON.stringify({ tool: "Bash", input: { command: "mkdir out" }, cwd: CHECK_CWD }), as });
  const decide = async (allow: boolean) => {
    let id = "";
    await h.waitFor(async () => {
      const g = await h.json<{ pending: { id: string }[] }>(await h.api("/api/guard"));
      id = g.pending[0]?.id ?? "";
      return id !== "";
    }, "approval card");
    await h.api(`/api/guard/approvals/${id}`, { method: "POST", body: JSON.stringify({ allow }) });
  };

  const asking = check("nana");
  await decide(true);
  assert.deepEqual(await h.json(await asking), { decision: "allow", asked: true });

  await patch(h, "nana", { toolMode: "full" });
  assert.deepEqual(await h.json(await check("nana")), { decision: "allow", asked: false });

  await patch(h, "nana", { toolMode: "read-only" });
  const denied = await h.json<{ decision: string; reason: string; asked: boolean }>(await check("nana"));
  assert.deepEqual([denied.decision, denied.asked], ["deny", false]);
  assert.match(denied.reason, /nana is in read-only mode/);
  assert.deepEqual(await h.json(await check("ada")), { decision: "allow", asked: false }, "another agent keeps its own mode");
});

test("tool mode audit: a read-only deny logs source mode, and each entry sends a socket event", async (t) => {
  const h = await boot(t);
  await post(h, { id: "nana", runtime: "claude-code", toolMode: "read-only" });

  const frames: Seen[] = [];
  const socket = new WebSocket(`${h.url.replace(/^http/, "ws")}/ws?token=${encodeURIComponent(h.tokens()["owner"]!)}`);
  socket.on("message", (data) => frames.push(JSON.parse(String(data)) as Seen));
  t.after(() => socket.terminate());
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });

  const check = (tool: string, input: unknown) =>
    h.api("/guard/check", { method: "POST", body: JSON.stringify({ tool, input, cwd: CHECK_CWD }), as: "nana" });
  const denied = await h.json<{ decision: string }>(await check("Write", { file_path: `${CHECK_CWD}\\a.txt`, content: "hi" }));
  assert.equal(denied.decision, "deny");

  const state = await h.json<{ recent: { outcome: string; verdict: string; source: string; agent: string }[] }>(await h.api("/api/guard"));
  assert.deepEqual(
    state.recent.map((e) => [e.agent, e.verdict, e.outcome, e.source]),
    [["nana", "allow", "denied", "mode"]],
  );
  await h.waitFor(async () => frames.filter((f) => f.type === "guard").length >= 1, "a guard frame");
  const guardFrames = frames.filter((f) => f.type === "guard");
  assert.deepEqual(
    guardFrames.map((f) => [f.entry?.tool, f.entry?.outcome, f.entry?.source]),
    [["Write", "denied", "mode"]],
  );
});
