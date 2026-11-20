import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { WebSocket } from "ws";
import type { Caller } from "../src/config.ts";
import { ensureTokens } from "../src/auth/tokens.ts";
import { startCore } from "../src/api/http.ts";
import { openDb } from "../src/db/db.ts";
import { writeSetting } from "../src/db/settings.ts";
import { Plugins, type PluginInfo } from "../src/plugins/plugins.ts";
import { tempHome, SEED_CALLERS } from "./helpers.ts";

// A sample plugin: one tool, one guard rule, one listener, and a panel.
const HELLO_INDEX = `export default function setup(api) {
  let messages = 0;
  api.tool({
    name: "echo",
    description: "Say the text back, with the number of messages this plugin saw.",
    input: { text: { type: "string", description: "Text to say back" } },
    run: ({ text }, { caller }) => caller + " said: " + text + " (messages seen: " + messages + ")",
  });
  api.guard((action) => {
    if (action.kind === "shell" && /\\bgit\\s+push\\b/.test(action.command ?? "")) {
      return { verdict: "ask", reason: "the hello plugin asks before a git push" };
    }
    return undefined;
  });
  api.on("message", () => {
    messages += 1;
  });
  api.log("ready");
  return () => api.log("unloaded");
}
`;
const HELLO_PANEL = `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><title>Hello</title></head>
<body><h3>Hello from a plugin panel</h3></body></html>
`;

function plugin(home: string, id: string, manifest: object, main?: string, direct = false): void {
  const dir = direct ? join(home, id) : join(home, "plugins", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "plugin.json"), JSON.stringify(manifest));
  if (main !== undefined) writeFileSync(join(dir, "index.mjs"), main);
}

async function setup(t: TestContext) {
  const home = tempHome();
  plugin(home.dir, "hello", { name: "Hello", version: "0.1.0", main: "index.mjs", panel: "panel.html" }, HELLO_INDEX);
  writeFileSync(join(home.dir, "plugins", "hello", "panel.html"), HELLO_PANEL);
  plugin(home.dir, "broken", { name: "Broken", main: "index.mjs" }, "export default function () { throw new Error('boom'); }");
  plugin(
    home.dir,
    "thrower",
    { name: "Thrower", main: "index.mjs" },
    "export default function (api) { api.guard(() => { throw new Error('bad rule'); }); }",
  );
  const core = await startCore({ home: home.dir, port: 0, approvalMs: 100 });
  t.after(async () => {
    await core.close();
    home.cleanup();
  });
  const tokens = ensureTokens(home.dir, SEED_CALLERS);
  const api = (path: string, init: RequestInit & { as?: Caller } = {}) => {
    const { as = "owner", ...rest } = init;
    return fetch(core.url + path, {
      ...rest,
      headers: { "content-type": "application/json", authorization: `Bearer ${tokens[as]}` },
    });
  };
  const enable = async (id: string, enabled = true) =>
    ((await (await api(`/api/plugins/${id}`, { method: "PUT", body: JSON.stringify({ enabled }) })).json()) as {
      plugins: PluginInfo[];
    }).plugins;
  const check = async (command: string) =>
    (await (
      await api("/guard/check", {
        method: "POST",
        as: "ada",
        body: JSON.stringify({ tool: "Bash", input: { command }, cwd: "E:\\projects\\x" }),
      })
    ).json()) as { decision: string; reason?: string };
  return { url: core.url, tokens, api, enable, check };
}

async function mcpTools(url: string, token: string) {
  const transport = new StreamableHTTPClientTransport(new URL(`${url}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(transport);
  return client;
}

test("a disabled plugin loads nothing; enable adds its tool, panel, and grant row", async (t) => {
  const h = await setup(t);
  const before = ((await (await h.api("/api/plugins")).json()) as { plugins: PluginInfo[] }).plugins;
  const hello = before.find((p) => p.id === "hello")!;
  assert.deepEqual([hello.enabled, hello.tools, hello.guards, hello.panel], [false, [], 0, undefined]);
  assert.equal((await fetch(`${h.url}/plugins/hello/panel.html`)).status, 404);

  const after = (await h.enable("hello")).find((p) => p.id === "hello")!;
  assert.deepEqual([after.enabled, after.tools, after.guards], [true, ["plugin_hello_echo"], 1]);
  assert.equal(after.panel, "/plugins/hello/panel.html");

  const page = await fetch(`${h.url}${after.panel}`);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get("content-security-policy"), "sandbox allow-scripts");
  assert.match(await page.text(), /plugin panel/);
  assert.equal((await fetch(`${h.url}/plugins/hello/..%2Fbroken%2Fplugin.json`)).status, 404);
  assert.equal((await fetch(`${h.url}/plugins/hello/%2e%2e/broken/plugin.json`)).status, 404);

  const grants = (await (await h.api("/api/grants")).json()) as { groups: { id: string }[] };
  assert.ok(grants.groups.some((g) => g.id === "plugin.hello"));
});

test("a plugin tool runs over MCP, sees messages, and obeys its grant", async (t) => {
  const h = await setup(t);
  await h.enable("hello");
  await h.api("/api/rooms/lounge/messages", { method: "POST", body: JSON.stringify({ text: "hi" }) });
  const client = await mcpTools(h.url, h.tokens.ada);
  t.after(() => client.close());
  const names = (await client.listTools()).tools.map((x) => x.name);
  assert.ok(names.includes("plugin_hello_echo"));
  const reply = (await client.callTool({ name: "plugin_hello_echo", arguments: { text: "yo" } })) as {
    content: { text: string }[];
  };
  assert.match(reply.content[0]!.text, /ada said: yo \(messages seen: 1\)/);

  await h.api("/api/grants/ada", { method: "PUT", body: JSON.stringify({ "plugin.hello": false }) });
  const off = (await client.callTool({ name: "plugin_hello_echo", arguments: { text: "yo" } })) as {
    isError?: boolean;
  };
  assert.equal(off.isError, true);
});

test("plugin guard rules ask, a throwing rule asks, and a load error shows", async (t) => {
  const h = await setup(t);
  assert.equal((await h.check("git push")).decision, "allow");
  await h.enable("hello");
  const pushed = await h.check("git push");
  assert.equal(pushed.decision, "deny");
  assert.match(pushed.reason!, /hello plugin asks/);

  await h.enable("hello", false);
  const list = await h.enable("thrower");
  assert.equal(list.find((p) => p.id === "thrower")!.guards, 1);
  const thrown = await h.check("ls");
  assert.equal(thrown.decision, "deny");
  assert.match(thrown.reason!, /thrower guard failed: bad rule/);

  const broken = (await h.enable("broken")).find((p) => p.id === "broken")!;
  assert.match(broken.error!, /setup failed: boom/);
  assert.equal((await h.api("/api/plugins/nope", { method: "PUT", body: '{"enabled":true}' })).status, 404);
});

// ---- runtime plugins ----

interface Probe {
  created: number;
  started: number;
  gate: Promise<void>;
}

declare global {
  // The fixture adapters read this: they run in the same process.
  var __echoProbe: Probe | undefined;
  var __slowGate: Promise<void> | undefined;
}

const QUIET = { adapters: { ada: { enabled: false }, cyd: { enabled: false } }, scheduler: { replyDelayMs: 0 } };

// A runtime that replies with a fixed text once the probe gate opens.
function runtimeSource(runtime: string, text: string): string {
  return `export default function (api) {
  api.runtime({
    id: ${JSON.stringify(runtime)},
    label: "Echo",
    efforts: () => ["low", "high"],
    models: () => [],
    create: () => {
      const probe = globalThis.__echoProbe;
      probe.created += 1;
      return {
        name: "echo",
        available: async () => ({ ok: true }),
        chatTurn: async () => {
          probe.started += 1;
          await probe.gate;
          return { kind: "post", text: ${JSON.stringify(text)} };
        },
      };
    },
  });
}`;
}

interface RuntimeHome {
  home: string;
  url: string;
  api(path: string, init?: RequestInit): Promise<Response>;
  token: string;
  enable(id: string, enabled?: boolean): Promise<PluginInfo[]>;
  plugins(): Promise<PluginInfo[]>;
  agents(): Promise<RuntimeView[]>;
  runtimeIds(): Promise<string[]>;
  say(text: string): Promise<void>;
  texts(author: string): Promise<string[]>;
  waitFor(check: () => boolean | Promise<boolean>, what: string): Promise<void>;
  hold(): () => void;
}

interface RuntimeView {
  id: string;
  runtime: string;
  efforts: string[];
  available: boolean;
  reason?: string;
}

async function runtimeSetup(
  t: TestContext,
  folders: Record<string, { manifest: object; main?: string }>,
  bundled: Record<string, { manifest: object; main?: string }> = {},
  probeMs?: number,
): Promise<RuntimeHome> {
  const home = tempHome();
  writeFileSync(join(home.dir, "config.json"), JSON.stringify(QUIET));
  for (const [id, p] of Object.entries(folders)) plugin(home.dir, id, p.manifest, p.main);
  // An own bundled folder keeps the real bundled plugins out of these tests.
  const bundledDir = join(home.dir, "bundled");
  mkdirSync(bundledDir, { recursive: true });
  for (const [id, p] of Object.entries(bundled)) plugin(bundledDir, id, p.manifest, p.main, true);
  globalThis.__echoProbe = { created: 0, started: 0, gate: Promise.resolve() };
  const core = await startCore({
    home: home.dir,
    port: 0,
    schedule: true,
    bundledPlugins: bundledDir,
    ...(probeMs === undefined ? {} : { probeMs }),
  });
  t.after(async () => {
    await core.close();
    delete globalThis.__echoProbe;
    home.cleanup();
  });
  const token = ensureTokens(home.dir, SEED_CALLERS).owner!;
  const api = (path: string, init: RequestInit = {}) =>
    fetch(core.url + path, {
      ...init,
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    });
  const h: RuntimeHome = {
    home: home.dir,
    url: core.url,
    api,
    token,
    async enable(id, enabled = true) {
      const res = await api(`/api/plugins/${id}`, { method: "PUT", body: JSON.stringify({ enabled }) });
      return ((await res.json()) as { plugins: PluginInfo[] }).plugins;
    },
    async plugins() {
      return ((await (await api("/api/plugins")).json()) as { plugins: PluginInfo[] }).plugins;
    },
    async agents() {
      return ((await (await api("/api/agents")).json()) as { agents: RuntimeView[] }).agents;
    },
    async runtimeIds() {
      const body = (await (await api("/api/agents")).json()) as { runtimes: { id: string }[] };
      return body.runtimes.map((r) => r.id);
    },
    async say(text) {
      const res = await api("/api/rooms/lounge/messages", { method: "POST", body: JSON.stringify({ text }) });
      assert.equal(res.status, 201);
    },
    async texts(author) {
      const res = await api("/api/rooms/lounge/messages?limit=200");
      const messages = (await res.json()) as { author: string; text: string }[];
      return messages.filter((m) => m.author === author).map((m) => m.text);
    },
    async waitFor(check, what) {
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        if (await check()) return;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.fail(`timed out: ${what}`);
    },
    hold() {
      let open!: () => void;
      globalThis.__echoProbe!.gate = new Promise<void>((resolve) => (open = resolve));
      return open;
    },
  };
  return h;
}

const ECHO_PLUGIN = (text = "echo reply") => ({
  manifest: { name: "Echo", main: "index.mjs", runtimes: ["echo"] },
  main: runtimeSource("echo", text),
});

async function addNana(h: RuntimeHome, runtime = "echo"): Promise<void> {
  const res = await h.api("/api/agents", {
    method: "POST",
    body: JSON.stringify({ id: "nana", runtime, effort: "high" }),
  });
  assert.equal(res.status, 201);
}

test("runtime plugin: it lists, replies, and leaves with the reason and no scheduler retries", async (t) => {
  const h = await runtimeSetup(t, { "echo-rt": ECHO_PLUGIN() });
  assert.equal((await h.runtimeIds()).includes("echo"), false, "a disabled plugin adds nothing");
  const bad = await h.api("/api/agents", { method: "POST", body: JSON.stringify({ id: "nana", runtime: "echo" }) });
  assert.equal(bad.status, 400);

  const list = await h.enable("echo-rt");
  assert.deepEqual(list.find((p) => p.id === "echo-rt")!.runtimes, ["echo"]);
  const listed = (await (await h.api("/api/agents")).json()) as { runtimes: { id: string; label: string; toolModes: boolean }[] };
  assert.deepEqual(listed.runtimes.find((r) => r.id === "echo"), { id: "echo", label: "Echo", toolModes: false });
  const choices = (await (await h.api("/api/runtimes/echo/efforts")).json()) as { efforts: string[] };
  assert.deepEqual(choices.efforts, ["low", "high"]);
  await addNana(h);
  const nana = (await h.agents()).find((i) => i.id === "nana")!;
  assert.deepEqual([nana.runtime, nana.efforts, nana.available, nana.reason], ["echo", ["low", "high"], true, undefined]);

  await h.say("@nana one");
  await h.waitFor(async () => (await h.texts("nana")).length === 1, "first reply");
  assert.deepEqual(await h.texts("nana"), ["echo reply"]);
  assert.equal(globalThis.__echoProbe!.created, 1);

  // A reload makes a new runtime kind: the next turn builds a new adapter.
  assert.equal((await h.api("/api/plugins/reload", { method: "POST" })).status, 200);
  await h.say("@nana two");
  await h.waitFor(async () => (await h.texts("nana")).length === 2, "reply after reload");
  assert.equal(globalThis.__echoProbe!.created, 2);

  const lines: string[] = [];
  t.mock.method(console, "log", (...args: unknown[]) => void lines.push(args.join(" ")));
  const after = await h.enable("echo-rt", false);
  assert.deepEqual(after.find((p) => p.id === "echo-rt")!.runtimes, ["echo"], "the manifest still names it");
  assert.equal((await h.runtimeIds()).includes("echo"), false);
  const gone = (await h.agents()).find((i) => i.id === "nana")!;
  assert.deepEqual([gone.runtime, gone.available, gone.reason], ["echo", false, "runtime echo needs plugin echo-rt"]);

  await h.say("@nana three");
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal((await h.texts("nana")).length, 2, "no turn ran");
  assert.equal(lines.some((l) => /nana turn failed/.test(l)), false, "the scheduler skipped her");
  const sched = (await (await h.api("/api/scheduler")).json()) as { running: string | null; queued: string[] };
  assert.deepEqual([sched.running, sched.queued], [null, []]);

  // She can still be edited while her runtime is missing.
  const edit = await h.api("/api/agents/nana", { method: "PATCH", body: JSON.stringify({ enabled: false }) });
  assert.equal(edit.status, 200);
  const turbo = await h.api("/api/agents/nana", { method: "PATCH", body: JSON.stringify({ effort: "max" }) });
  assert.equal(turbo.status, 400, "a missing runtime cannot vouch for a new effort");

  await h.enable("echo-rt");
  const back = (await h.agents()).find((i) => i.id === "nana")!;
  assert.deepEqual([back.available, back.reason], [true, undefined]);
});

test("runtime plugin: a disabled plugin lets a running turn post; the next turn gets the reason", async (t) => {
  const h = await runtimeSetup(t, { "echo-rt": ECHO_PLUGIN() });
  await h.enable("echo-rt");
  await addNana(h);
  const release = h.hold();

  await h.say("@nana go");
  await h.waitFor(() => globalThis.__echoProbe!.started === 1, "the turn started");
  await h.enable("echo-rt", false);
  assert.equal((await h.runtimeIds()).includes("echo"), false);
  assert.deepEqual(await h.texts("nana"), []);

  release();
  await h.waitFor(async () => (await h.texts("nana")).length === 1, "the running turn posts");
  assert.deepEqual(await h.texts("nana"), ["echo reply"]);

  const client = await mcpTools(h.url, h.token);
  t.after(() => client.close());
  const opened = (await client.callTool({
    name: "session_open",
    arguments: { agent: "nana", kind: "chat", brief: "hi" },
  })) as { content: { text: string }[] };
  const id = (JSON.parse(opened.content[0]!.text) as { id: string }).id;
  let view = { state: "", reason: "" };
  await h.waitFor(async () => {
    const status = (await client.callTool({ name: "session_status", arguments: { id } })) as {
      content: { text: string }[];
    };
    view = JSON.parse(status.content[0]!.text) as typeof view;
    return view.state === "failed";
  }, "the next turn fails");
  assert.equal(view.reason, "runtime echo needs plugin echo-rt");
  assert.equal(globalThis.__echoProbe!.started, 1, "no adapter ran");
});

test("runtime plugin: the first plugin keeps an id; a second one gets a load error", async (t) => {
  const h = await runtimeSetup(t, {
    "echo-a": ECHO_PLUGIN("from a"),
    "echo-b": ECHO_PLUGIN("from b"),
  });
  await h.enable("echo-a");
  const list = await h.enable("echo-b");
  const a = list.find((p) => p.id === "echo-a")!;
  const b = list.find((p) => p.id === "echo-b")!;
  assert.equal(a.error, undefined);
  assert.deepEqual(a.runtimes, ["echo"]);
  assert.match(b.error!, /setup failed: runtime echo already belongs to plugin echo-a/);
  assert.equal((await h.runtimeIds()).filter((id) => id === "echo").length, 1);

  await addNana(h);
  await h.say("@nana hi");
  await h.waitFor(async () => (await h.texts("nana")).length === 1, "reply");
  assert.deepEqual(await h.texts("nana"), ["from a"], "the first plugin's adapter ran");
  assert.equal((await h.agents()).find((i) => i.id === "nana")!.reason, undefined);

  // The failed plugin frees its claim when the first one leaves.
  await h.enable("echo-a", false);
  const swapped = await h.plugins();
  assert.equal(swapped.find((p) => p.id === "echo-b")!.error, undefined);
  assert.equal((await h.agents()).find((i) => i.id === "nana")!.available, true);
});

test("runtime plugin: a core id, a bad id, and a bad manifest list are load errors", async (t) => {
  const claim = (id: string) =>
    `export default function (api) { api.runtime({ id: ${JSON.stringify(id)}, label: "X", efforts: () => [], models: () => [], create: () => ({}) }); }`;
  const h = await runtimeSetup(t, {
    "take-stub": { manifest: { name: "S", main: "index.mjs" }, main: claim("stub") },
    "take-bad": { manifest: { name: "B", main: "index.mjs" }, main: claim("Not Valid") },
    "bad-list": { manifest: { name: "Bad", main: "index.mjs", runtimes: "echo" }, main: claim("fine") },
  });
  for (const id of ["take-stub", "take-bad", "bad-list"]) await h.enable(id);
  const byId = Object.fromEntries((await h.plugins()).map((p) => [p.id, p]));
  assert.match(byId["take-stub"]!.error!, /runtime stub is a core runtime/);
  assert.match(byId["take-bad"]!.error!, /a runtime id must be 2 to 24 characters/);
  assert.match(byId["bad-list"]!.error!, /runtimes must be a list of runtime ids/);
  assert.deepEqual((await h.runtimeIds()).sort(), ["stub"]);
});

test("bundled plugins: they list with the label flag, and a home plugin of the same id wins", async (t) => {
  const h = await runtimeSetup(
    t,
    { same: ECHO_PLUGIN("from home") },
    {
      same: ECHO_PLUGIN("from bundled"),
      ship: { manifest: { name: "Ship", main: "index.mjs", runtimes: ["echo"] }, main: runtimeSource("echo", "from ship") },
    },
  );
  const list = await h.plugins();
  assert.deepEqual(list.map((p) => [p.id, p.bundled]), [["same", false], ["ship", true]]);
  await h.enable("ship");
  await addNana(h);
  await h.say("@nana hi");
  await h.waitFor(async () => (await h.texts("nana")).length === 1, "reply");
  assert.deepEqual(await h.texts("nana"), ["from ship"]);
});

test("runtime plugin: a reload keeps the old kinds until it ends", async (t) => {
  const home = tempHome();
  const db = openDb(join(home.dir, "lounge.db"));
  t.after(async () => {
    delete globalThis.__slowGate;
    db.close();
    home.cleanup();
  });
  plugin(home.dir, "echo-rt", ECHO_PLUGIN().manifest, ECHO_PLUGIN().main);
  // Its setup waits for the gate: the reload parks here.
  plugin(home.dir, "slow", { name: "Slow", main: "index.mjs" }, "export default async function () { await globalThis.__slowGate; }");
  writeSetting(db, "plugins.enabled", JSON.stringify(["echo-rt"]));
  const plugins = new Plugins({
    home: home.dir,
    db,
    bundledDir: join(home.dir, "no-bundled"),
    coreRuntimes: () => ["stub"],
    log: () => {},
  });
  await plugins.load();
  const first = plugins.runtimes();
  assert.deepEqual(first.map((k) => k.id), ["echo"]);

  let open!: () => void;
  globalThis.__slowGate = new Promise<void>((resolve) => (open = resolve));
  writeSetting(db, "plugins.enabled", JSON.stringify(["echo-rt", "slow"]));
  const reload = plugins.load();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(plugins.runtimes(), first, "a turn that starts now still finds the runtime");

  open();
  await reload;
  assert.deepEqual(plugins.runtimes().map((k) => k.id), ["echo"]);
  assert.notEqual(plugins.runtimes()[0], first[0], "the reload made a new kind");
  await plugins.close();
  assert.deepEqual(plugins.runtimes(), []);
});

test("runtime plugin: a re-enable probes at once, and each change sends one roster frame", async (t) => {
  // The interval is long: only the plugin change can make nana reachable.
  const h = await runtimeSetup(t, { "echo-rt": ECHO_PLUGIN() }, {}, 3_600_000);
  const socket = new WebSocket(`${h.url.replace(/^http/, "ws")}/ws?token=${encodeURIComponent(h.token)}`);
  t.after(() => socket.close());
  const frames: { type: string; id?: string; kind?: string }[] = [];
  socket.on("message", (data) => frames.push(JSON.parse(String(data)) as (typeof frames)[number]));
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });
  const changes = () => frames.filter((f) => f.type === "roster" && f.id === "");

  await h.enable("echo-rt");
  await h.waitFor(() => changes().length === 1, "a frame for the enable");
  await addNana(h);
  await h.enable("echo-rt", false);
  await h.waitFor(() => changes().length === 2, "a frame for the disable");
  await h.enable("echo-rt");
  await h.waitFor(() => changes().length === 3, "a frame for the re-enable");
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(changes().length, 3, "one frame for each change");
  assert.deepEqual(changes()[0], { type: "roster", id: "", kind: "update" });

  await h.say("@nana right after the enable");
  await h.waitFor(async () => (await h.texts("nana")).length === 1, "the mention starts a turn");
  assert.deepEqual(await h.texts("nana"), ["echo reply"]);
});

test("runtime plugin: loads run in order, so an older load cannot commit stale state", async (t) => {
  const home = tempHome();
  const db = openDb(join(home.dir, "lounge.db"));
  t.after(() => {
    delete globalThis.__slowGate;
    db.close();
    home.cleanup();
  });
  // Its setup waits for the gate, then adds a runtime.
  const slow = `export default async function (api) {
  await globalThis.__slowGate;
  api.runtime({ id: "slow-rt", label: "Slow", efforts: () => [], models: () => [], create: () => ({}) });
}`;
  plugin(home.dir, "slow", { name: "Slow", main: "index.mjs", runtimes: ["slow-rt"] }, slow);
  const logs: string[] = [];
  const plugins = new Plugins({
    home: home.dir,
    db,
    bundledDir: join(home.dir, "no-bundled"),
    coreRuntimes: () => ["stub"],
    log: (line) => logs.push(line),
  });

  let open!: () => void;
  globalThis.__slowGate = new Promise<void>((resolve) => (open = resolve));
  // Two quick toggles: on, then off. The first load parks in its setup.
  writeSetting(db, "plugins.enabled", JSON.stringify(["slow"]));
  const first = plugins.load();
  await new Promise((resolve) => setTimeout(resolve, 50));
  writeSetting(db, "plugins.enabled", JSON.stringify([]));
  const second = plugins.load();
  await new Promise((resolve) => setTimeout(resolve, 50));
  open();
  await Promise.all([first, second]);

  const info = plugins.list().find((p) => p.id === "slow")!;
  assert.equal(info.enabled, false, "the last toggle wins");
  assert.deepEqual(plugins.runtimes(), []);
  assert.equal(plugins.runtimeOwner("slow-rt"), "slow", "the manifest still names it");
  await plugins.close();
});

test("bundled plugins: a home plugin that replaces a bundled one is logged at load", async (t) => {
  const logs: string[] = [];
  const home = tempHome();
  const db = openDb(join(home.dir, "lounge.db"));
  t.after(() => {
    db.close();
    home.cleanup();
  });
  const bundledDir = join(home.dir, "bundled");
  plugin(bundledDir, "same", { name: "Bundled" }, undefined, true);
  plugin(bundledDir, "only", { name: "Only" }, undefined, true);
  plugin(home.dir, "same", { name: "Home" });
  const plugins = new Plugins({ home: home.dir, db, bundledDir, log: (line) => logs.push(line) });
  await plugins.load();
  assert.deepEqual(logs, ["plugin same: home folder replaces the bundled plugin"]);
  assert.equal(plugins.list().find((p) => p.id === "same")!.name, "Home");
});
