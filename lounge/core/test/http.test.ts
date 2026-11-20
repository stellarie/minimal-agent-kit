import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { WebSocket } from "ws";
import { loadConfig, type Caller } from "../src/config.ts";
import { ensureTokens, healthProof } from "../src/auth/tokens.ts";
import { startCore } from "../src/api/http.ts";
import type { Message } from "../src/lounge/room.ts";
import type { Adapter } from "../src/adapters/types.ts";
import { fakeKinds, tempHome, SEED_CALLERS } from "./helpers.ts";
import { unavailableAdapter } from "../src/adapters/stub.ts";

interface Harness {
  url: string;
  home: string;
  tokens: Record<Caller, string>;
  api(path: string, init?: RequestInit & { as?: Caller | null }): Promise<Response>;
}

async function setup(t: TestContext): Promise<Harness> {
  const home = tempHome();
  // Only the claude-code runtime is loaded: the codex rows show as unavailable.
  const runtimes = fakeKinds(() => unavailableAdapter("claude", "test stub")).filter((k) => k.id === "claude-code");
  const core = await startCore({ home: home.dir, port: 0, runtimes });
  t.after(async () => {
    await core.close();
    home.cleanup();
  });
  const tokens = ensureTokens(home.dir, SEED_CALLERS);
  return {
    url: core.url,
    home: home.dir,
    tokens,
    api(path, init = {}) {
      const { as = "owner", ...rest } = init;
      const headers = new Headers(rest.headers);
      if (as) headers.set("authorization", `Bearer ${tokens[as]}`);
      return fetch(core.url + path, { ...rest, headers });
    },
  };
}

function writeConfig(home: string, patch: Record<string, unknown>): void {
  loadConfig(home);
  const file = join(home, "config.json");
  const config = JSON.parse(readFileSync(file, "utf8"));
  writeFileSync(file, JSON.stringify({ ...config, ...patch }));
}

async function openSocket(t: TestContext, h: Harness, caller: Caller = "owner") {
  const wsUrl = `${h.url.replace(/^http/, "ws")}/ws?token=${encodeURIComponent(h.tokens[caller])}`;
  const socket = new WebSocket(wsUrl);
  const received: unknown[] = [];
  socket.on("message", (data) => received.push(JSON.parse(String(data))));
  t.after(() => socket.terminate());
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });
  // Every socket opens with a layout snapshot.
  for (let i = 0; i < 100 && !received.some((f) => (f as { type?: string }).type === "layout"); i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  // Then the open approval cards.
  for (const type of ["layout", "approval"]) {
    for (let i = 0; i < 100 && !received.some((f) => (f as { type?: string }).type === type); i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    const at = received.findIndex((f) => (f as { type?: string }).type === type);
    if (at >= 0) received.splice(at, 1);
  }
  return {
    socket,
    next(timeoutMs = 1000): Promise<unknown> {
      return new Promise((resolve, reject) => {
        const started = Date.now();
        const poll = () => {
          if (received.length > 0) return resolve(received.shift());
          if (Date.now() - started > timeoutMs) return reject(new Error("no ws message"));
          setTimeout(poll, 10);
        };
        poll();
      });
    },
  };
}

test("health needs no token", async (t) => {
  const h = await setup(t);
  const res = await h.api("/health", { as: null });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
});

test("health proves the core holds the owner token", async (t) => {
  const h = await setup(t);
  const res = await h.api("/health?challenge=abc123", { as: null });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {
    ok: true,
    proof: createHmac("sha256", h.tokens.owner).update("agent-lounge-health:abc123").digest("hex"),
  });
  const tooLong = await h.api(`/health?challenge=${"a".repeat(129)}`, { as: null });
  assert.equal(tooLong.status, 400);
});

test("health proof matches the desktop shell vector", () => {
  // The desktop shell health check uses the same context text and result.
  assert.equal(
    healthProof("secret-token", "abc123"),
    "65cee779e01dcf56e78a50808cfc8953c64bb7ee004ad9e7a4d41b5861861148",
  );
});

test("api rejects an agent token", async (t) => {
  const h = await setup(t);
  assert.equal((await h.api("/api/who", { as: "ada" })).status, 403);
  assert.equal((await h.api("/api/who", { as: null })).status, 401);
  assert.equal(
    (await h.api("/api/who", { as: null, headers: { authorization: "Bearer garbage" } })).status,
    401,
  );
  assert.equal((await h.api("/api/rooms/lounge/messages", { as: "dee" })).status, 403);
  const ok = await h.api("/api/who");
  assert.equal(ok.status, 200);
  const who = (await ok.json()) as { caller: string; adapter?: string }[];
  assert.equal(who.length, 5);
  assert.equal(who.find((w) => w.caller === "bea")?.adapter, "unavailable");
  assert.equal(who.find((w) => w.caller === "dee")?.adapter, "unavailable");
  assert.equal(who.find((w) => w.caller === "ada")?.adapter, "enabled");
});

test("api reads messages with since and limit", async (t) => {
  const h = await setup(t);
  const ids: number[] = [];
  for (const text of ["a", "b", "c"]) {
    const res = await h.api("/api/rooms/lounge/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
    assert.equal(res.status, 201);
    ids.push(((await res.json()) as Message).id);
  }
  const all = (await (await h.api("/api/rooms/lounge/messages")).json()) as Message[];
  assert.deepEqual(all.map((m) => m.text), ["a", "b", "c"]);
  const since = (await (
    await h.api(`/api/rooms/lounge/messages?since=${ids[0]}&limit=1`)
  ).json()) as Message[];
  assert.deepEqual(since.map((m) => m.id), [ids[1]]);
  const older = (await (
    await h.api(`/api/rooms/lounge/messages?before=${ids[2]}&limit=1`)
  ).json()) as Message[];
  assert.deepEqual(older.map((m) => m.id), [ids[1]]);
  assert.equal((await h.api("/api/rooms/lounge/messages?since=abc")).status, 400);
  assert.equal((await h.api("/api/rooms/lounge/messages?before=x")).status, 400);
});

test("api rejects bad text and unknown rooms with a reason", async (t) => {
  const h = await setup(t);
  const post = (path: string, body: unknown) =>
    h.api(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const empty = await post("/api/rooms/lounge/messages", { text: "  " });
  assert.equal(empty.status, 400);
  assert.equal(((await empty.json()) as { error: string }).error, "bad_text");
  const long = await post("/api/rooms/lounge/messages", { text: "x".repeat(2001) });
  assert.equal(long.status, 400);
  const missing = await post("/api/rooms/nope/messages", { text: "hi" });
  assert.equal(missing.status, 404);
  assert.equal(((await missing.json()) as { message: string }).message, "unknown room: nope");
  const noText = await post("/api/rooms/lounge/messages", { body: "hi" });
  assert.equal(noText.status, 400);
  const notJson = await h.api("/api/rooms/lounge/messages", { method: "POST", body: "{" });
  assert.equal(notJson.status, 400);
});

test("owner post is broadcast on ws", async (t) => {
  const h = await setup(t);
  const ws = await openSocket(t, h);
  const res = await h.api("/api/rooms/lounge/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "hi" }),
  });
  assert.equal(res.status, 201);
  const posted = (await res.json()) as Message;
  assert.equal(posted.author, "owner");
  assert.deepEqual(await ws.next(1000), { type: "message", message: posted });
});

test("MCP post is broadcast on ws", async (t) => {
  const h = await setup(t);
  const ws = await openSocket(t, h);
  const client = new Client({ name: "test-ada", version: "0.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${h.url}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${h.tokens.ada}` } },
    }),
  );
  t.after(() => client.close());
  await client.callTool({ name: "lounge_post", arguments: { room: "lounge", text: "from ada" } });
  const event = (await ws.next(1000)) as { type: string; message: Message };
  assert.equal(event.type, "message");
  assert.equal(event.message.author, "ada");
  assert.equal(event.message.text, "from ada");
});

test("ws rejects a missing or agent token", async (t) => {
  const h = await setup(t);
  const base = `${h.url.replace(/^http/, "ws")}/ws`;
  for (const url of [base, `${base}?token=${encodeURIComponent(h.tokens.ada)}`]) {
    const status = await new Promise<number>((resolve, reject) => {
      const socket = new WebSocket(url);
      socket.once("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
      socket.once("open", () => reject(new Error("socket opened")));
      socket.once("error", () => undefined);
    });
    assert.ok(status === 401 || status === 403, `status ${status}`);
  }
});

test("config host 0.0.0.0 refuses to start", async (t) => {
  const home = tempHome();
  t.after(home.cleanup);
  writeConfig(home.dir, { host: "0.0.0.0" });
  const started = startCore({ home: home.dir, port: 0 }).then(async (core) => {
    await core.close();
    throw new Error("core started on a non-loopback host");
  });
  await assert.rejects(started, /0\.0\.0\.0/);
});

test("port in use fails with the port in the message", async (t) => {
  const home = tempHome();
  t.after(home.cleanup);
  const blocker = createServer();
  await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => blocker.close(resolve)));
  const { port } = blocker.address() as AddressInfo;
  await assert.rejects(startCore({ home: home.dir, port }), (err: Error) => {
    assert.match(err.message, new RegExp(`\\b${port}\\b`));
    return true;
  });
});

const MAIN = fileURLToPath(new URL("../src/main.ts", import.meta.url));

function runMain(home: string) {
  const child = spawn(process.execPath, [MAIN], {
    env: { ...process.env, AGENT_LOUNGE_HOME: home },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stderr += d));
  const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
  return { child, exited, out: () => stdout, err: () => stderr };
}

test("main prints the url and tokens path, never a token", async (t) => {
  const home = tempHome();
  writeConfig(home.dir, { port: 0 });
  const run = runMain(home.dir);
  t.after(async () => {
    if (run.child.exitCode === null) run.child.kill();
    await run.exited;
    home.cleanup();
  });
  const deadline = Date.now() + 10000;
  const tokensPath = join(home.dir, "tokens.json");
  // The two startup lines arrive in separate writes, so wait for both.
  while (
    !(/http:\/\/127\.0\.0\.1:\d+/.test(run.out()) && run.out().includes(tokensPath)) &&
    Date.now() < deadline
  ) {
    await new Promise((r) => setTimeout(r, 25));
  }
  const url = /http:\/\/127\.0\.0\.1:\d+/.exec(run.out())?.[0];
  assert.ok(url, `no url in stdout: ${run.out()} ${run.err()}`);
  assert.ok(run.out().includes(tokensPath));
  const health = await fetch(`${url}/health`);
  assert.equal(health.status, 200);
  for (const token of Object.values(ensureTokens(home.dir, SEED_CALLERS))) {
    assert.ok(!run.out().includes(token), "stdout leaks a token");
    assert.ok(!run.err().includes(token), "stderr leaks a token");
  }
});

test("main exits with an error that names a non-loopback host", async (t) => {
  const home = tempHome();
  t.after(home.cleanup);
  writeConfig(home.dir, { host: "0.0.0.0", port: 0 });
  const run = runMain(home.dir);
  const timeout = new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 10000).unref());
  const code = await Promise.race([run.exited, timeout]);
  if (code === "timeout") {
    run.child.stdout.destroy();
    run.child.stderr.destroy();
    run.child.kill("SIGKILL");
    await run.exited;
  }
  assert.notEqual(code, "timeout", "main kept running on a non-loopback host");
  assert.notEqual(code, 0);
  assert.match(run.err(), /0\.0\.0\.0/);
});

test("api reads and sets the scheduler toggle", async (t) => {
  const h = await setup(t);
  const first = (await (await h.api("/api/scheduler")).json()) as { enabled: boolean; paused: boolean };
  assert.equal(first.enabled, true);
  assert.equal(first.paused, false);
  const put = (body: unknown, as: Caller = "owner") =>
    h.api("/api/scheduler", {
      as,
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  assert.equal((await put({ enabled: false }, "ada")).status, 403);
  assert.equal((await put({ enabled: "no" })).status, 400);
  const off = await put({ enabled: false });
  assert.equal(off.status, 200);
  assert.equal(((await off.json()) as { enabled: boolean }).enabled, false);
  assert.equal(((await (await h.api("/api/scheduler")).json()) as { enabled: boolean }).enabled, false);
  assert.equal((await h.api("/api/scheduler", { method: "DELETE" })).status, 405);
});

test("api creates channels, sets topics, and broadcasts both", async (t) => {
  const h = await setup(t);
  const ws = await openSocket(t, h);
  const json = { "content-type": "application/json" };
  const created = await h.api("/api/rooms", { method: "POST", headers: json, body: JSON.stringify({ name: "Games" }) });
  assert.equal(created.status, 201);
  assert.deepEqual(await created.json(), { id: "games", name: "games", topic: "" });
  assert.deepEqual(await ws.next(), { type: "channel", channel: { id: "games", name: "games", topic: "" } });
  const event = (await ws.next()) as { message: Message };
  assert.equal(event.message.kind, "event");

  const dup = await h.api("/api/rooms", { method: "POST", headers: json, body: JSON.stringify({ name: "games" }) });
  assert.equal(dup.status, 409);
  const bad = await h.api("/api/rooms", { method: "POST", headers: json, body: JSON.stringify({ name: "" }) });
  assert.equal(bad.status, 400);

  const topic = await h.api("/api/rooms/games", { method: "PATCH", headers: json, body: JSON.stringify({ topic: "co-op" }) });
  assert.equal(topic.status, 200);
  assert.equal(((await topic.json()) as { topic: string }).topic, "co-op");
  const missing = await h.api("/api/rooms/nope", { method: "PATCH", headers: json, body: JSON.stringify({ topic: "x" }) });
  assert.equal(missing.status, 404);

  const list = (await (await h.api("/api/rooms")).json()) as { id: string }[];
  assert.deepEqual(list.map((c) => c.id), ["lounge", "games"]);
  const agent = await h.api("/api/rooms", { as: "ada" });
  assert.equal(agent.status, 403);
});

test("api sets owner's name and broadcasts it", async (t) => {
  const h = await setup(t);
  const ws = await openSocket(t, h);
  const res = await h.api("/api/nickname", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Onii" }),
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await ws.next(), { type: "nickname", caller: "owner", name: "Onii" });
  const who = (await (await h.api("/api/who")).json()) as { caller: string; nickname?: string }[];
  assert.equal(who.find((w) => w.caller === "owner")?.nickname, "Onii");
  const bad = await h.api("/api/nickname", { method: "PUT", body: JSON.stringify({ name: "a\nb" }) });
  assert.equal(bad.status, 400);
});

test("api renames a channel, manages categories, and sends layout frames", async (t) => {
  const h = await setup(t);
  const ws = await openSocket(t, h);
  const json = { "content-type": "application/json" };
  const renamed = await h.api("/api/rooms/lounge", { method: "PATCH", headers: json, body: JSON.stringify({ name: "Living room" }) });
  assert.equal(renamed.status, 200);
  assert.equal(((await renamed.json()) as { id: string; name: string }).name, "Living room");
  const created = await h.api("/api/categories", { method: "POST", headers: json, body: JSON.stringify({ name: "Fun" }) });
  assert.equal(created.status, 201);
  const cat = (await created.json()) as { id: string };
  const put = await h.api("/api/layout", {
    method: "PUT",
    headers: json,
    body: JSON.stringify({ categories: [cat.id], channels: [{ id: "lounge", category: cat.id }] }),
  });
  assert.equal(put.status, 200);
  const layout = (await (await h.api("/api/layout")).json()) as { channels: { id: string; category?: string }[] };
  assert.equal(layout.channels.find((c) => c.id === "lounge")?.category, cat.id);
  const bad = await h.api("/api/layout", { method: "PUT", headers: json, body: JSON.stringify({ categories: [], channels: [] }) });
  assert.equal(bad.status, 400);
  assert.equal((await h.api(`/api/categories/${cat.id}`, { method: "DELETE" })).status, 204);
  assert.equal((await h.api(`/api/categories/${cat.id}`, { method: "DELETE" })).status, 404);
  const types: string[] = [];
  for (let i = 0; i < 5; i++) types.push(((await ws.next()) as { type: string }).type);
  assert.equal(types.filter((x) => x === "layout").length, 3);
});

test("api lists and changes an agent's tool grants", async (t) => {
  const h = await setup(t);
  const json = { "content-type": "application/json" };
  const first = (await (await h.api("/api/grants")).json()) as {
    groups: { id: string }[];
    grants: Record<string, Record<string, boolean>>;
  };
  assert.ok(first.groups.some((g) => g.id === "nick"));
  assert.equal(first.grants["ada"]?.["nick"], true);
  const res = await h.api("/api/grants/ada", { method: "PUT", headers: json, body: JSON.stringify({ nick: false }) });
  assert.equal(res.status, 200);
  assert.equal(((await res.json()) as Record<string, boolean>)["nick"], false);
  const bad = await h.api("/api/grants/ada", { method: "PUT", headers: json, body: JSON.stringify({ fly: true }) });
  assert.equal(bad.status, 400);
  const nobody = await h.api("/api/grants/nobody", { method: "PUT", headers: json, body: "{}" });
  assert.equal(nobody.status, 404);
});

test("api schedules, lists, and cancels events, and broadcasts each change", async (t) => {
  const h = await setup(t);
  const ws = await openSocket(t, h);
  const json = { "content-type": "application/json" };
  const at = new Date(Date.now() + 3_600_000).toISOString();
  const res = await h.api("/api/events", { method: "POST", headers: json, body: JSON.stringify({ title: "Games", at }) });
  assert.equal(res.status, 201);
  const created = (await res.json()) as { id: number; state: string };
  assert.equal(created.state, "pending");
  const frames = [await ws.next(), await ws.next()] as { type: string }[];
  assert.deepEqual(frames.map((f) => f.type).sort(), ["message", "scheduled"]);
  const list = (await (await h.api("/api/events")).json()) as { id: number }[];
  assert.deepEqual(list.map((e) => e.id), [created.id]);
  const cancel = await h.api(`/api/events/${created.id}`, { method: "DELETE" });
  assert.equal(((await cancel.json()) as { state: string }).state, "cancelled");
  assert.equal((await h.api("/api/events/999", { method: "DELETE" })).status, 404);
  const bad = await h.api("/api/events", { method: "POST", headers: json, body: JSON.stringify({ title: "x", at: "nope" }) });
  assert.equal(bad.status, 400);
});

test("api starts a thread, shows work, and stops it", async (t) => {
  const home = tempHome();
  // Ada reports one tool call, then waits to be stopped.
  const working: Adapter = {
    name: "claude",
    available: async () => ({ ok: true }),
    chatTurn: (input, signal) =>
      new Promise((_, reject) => {
        input.onActivity?.("Bash: npm test");
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }),
  };
  const core = await startCore({
    home: home.dir,
    port: 0,
    runtimes: fakeKinds((entry) => (entry.id === "ada" ? working : unavailableAdapter("claude", "test stub"))),
  });
  t.after(async () => {
    await core.close();
    home.cleanup();
  });
  const tokens = ensureTokens(home.dir, SEED_CALLERS);
  const api = (path: string, init: RequestInit = {}) =>
    fetch(core.url + path, {
      ...init,
      headers: { authorization: `Bearer ${tokens.owner}`, "content-type": "application/json" },
    });
  const res = await api("/api/threads", {
    method: "POST",
    body: JSON.stringify({ channel: "lounge", title: "Build", brief: "fix it", lead: "ada" }),
  });
  assert.equal(res.status, 201);
  const thread = (await res.json()) as { id: string; parent: string; lead: string };
  assert.equal(thread.parent, "lounge");
  const rooms = (await (await api("/api/rooms")).json()) as { id: string; parent?: string }[];
  assert.equal(rooms.find((r) => r.id === thread.id)?.parent, "lounge");
  let work: { agent: string; roomId: string; tool?: string }[] = [];
  for (let i = 0; i < 50 && work[0]?.tool === undefined; i++) {
    await new Promise((r) => setTimeout(r, 20));
    work = (await (await api("/api/work")).json()) as typeof work;
  }
  assert.deepEqual(work.map((w) => [w.agent, w.roomId, w.tool]), [["ada", thread.id, "Bash: npm test"]]);
  const stop = await api(`/api/threads/${thread.id}/stop`, { method: "POST" });
  assert.deepEqual(await stop.json(), { stopped: 1 });
  assert.equal((await api("/api/threads/thread-none/stop", { method: "POST" })).status, 404);
  const list = (await (await api("/api/threads")).json()) as { id: string }[];
  assert.deepEqual(list.map((x) => x.id), [thread.id]);
});

test("PATCH and DELETE /api/rooms/:id set channel settings and delete rooms", async (t) => {
  const h = await setup(t);
  const json = { "content-type": "application/json" };
  await h.api("/api/rooms", { method: "POST", headers: json, body: JSON.stringify({ name: "games" }) });
  const set = await h.api("/api/rooms/games", { method: "PATCH", headers: json, body: JSON.stringify({ mode: "sequential", slowSec: 120 }) });
  assert.equal(set.status, 200);
  const list = (await (await h.api("/api/rooms")).json()) as { id: string; mode?: string; slowSec?: number }[];
  assert.deepEqual(list.find((c) => c.id === "games"), { id: "games", name: "games", topic: "", mode: "sequential", slowSec: 120 });
  const bad = await h.api("/api/rooms/games", { method: "PATCH", headers: json, body: JSON.stringify({ slowSec: 99999 }) });
  assert.equal(bad.status, 400);
  assert.equal((await h.api("/api/rooms/games", { method: "DELETE", as: "dee" })).status, 403);
  assert.equal((await h.api("/api/rooms/lounge", { method: "DELETE" })).status, 403);
  const del = await h.api("/api/rooms/games", { method: "DELETE" });
  assert.equal(del.status, 200);
  assert.deepEqual(await del.json(), { removed: ["games"] });
  const after = (await (await h.api("/api/rooms")).json()) as { id: string }[];
  assert.deepEqual(after.map((c) => c.id), ["lounge"]);
  assert.equal((await h.api("/api/rooms/games", { method: "DELETE" })).status, 404);
});
