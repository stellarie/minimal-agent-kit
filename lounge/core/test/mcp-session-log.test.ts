import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { ensureTokens } from "../src/auth/tokens.ts";
import { openDb } from "../src/db/db.ts";
import { Room } from "../src/lounge/room.ts";
import { createMcpHandler, type McpOptions } from "../src/mcp/server.ts";
import { SESSION_LOG_MAX_BYTES, sessionLog, type SessionEvent } from "../src/mcp/session-log.ts";
import { SEED_CALLERS, sessionDeps, tempHome } from "./helpers.ts";

const INIT_BODY = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "raw", version: "0.0.0" } },
});
const CALL_BODY = JSON.stringify({
  jsonrpc: "2.0",
  id: 2,
  method: "tools/call",
  params: { name: "lounge_channels", arguments: { marker: "BODYMARK-7731" } },
});

async function setup(t: TestContext, options: McpOptions = {}, clock = { at: Date.UTC(2026, 10, 8) }) {
  const home = tempHome();
  const db = openDb(join(home.dir, "lounge.db"));
  const room = new Room(db);
  const tokens = ensureTokens(home.dir, SEED_CALLERS);
  const deps = sessionDeps({ db, room, home: home.dir });
  const file = join(home.dir, "mcp-session.log");
  const handler = createMcpHandler(
    { room, tokens, ...deps },
    { now: () => clock.at, log: sessionLog(file, () => new Date(clock.at)), ...options },
  );
  const server = createServer((req, res) => {
    void handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
  t.after(async () => {
    await handler.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    db.close();
    home.cleanup();
  });
  const headers = (token: string, extra: Record<string, string> = {}) => ({
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    authorization: `Bearer ${token}`,
    ...extra,
  });
  return {
    url,
    file,
    clock,
    tokens,
    restricted: deps.restricted,
    lines: (): string[] => (existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean) : []),
    async open(token: string): Promise<string> {
      const res = await fetch(url, { method: "POST", headers: headers(token), body: INIT_BODY });
      assert.equal(res.status, 200);
      await res.body?.cancel();
      const id = res.headers.get("mcp-session-id");
      assert.ok(id);
      return id;
    },
    async send(method: string, token: string, session: string, body?: string): Promise<Response> {
      const res = await fetch(url, {
        method,
        headers: headers(token, { "mcp-session-id": session, "mcp-protocol-version": "2025-06-18" }),
        body,
      });
      await res.body?.cancel();
      return res;
    },
  };
}

const kind = (lines: string[], name: string): string[] => lines.filter((l) => l.split(" ")[1] === name);

test("an idle drop writes one line with the reason and the age", async (t) => {
  const h = await setup(t, { idleMs: 1000 });
  const id = await h.open(h.tokens.ada);
  h.clock.at += 2500;
  const res = await h.send("GET", h.tokens.ada, id);
  assert.equal(res.status, 404);
  const drops = kind(h.lines(), "drop");
  assert.equal(drops.length, 1);
  assert.equal(drops[0], `2026-11-08T00:00:02.500Z drop reason=idle caller=ada session=${id.slice(0, 8)} ageMs=2500`);
});

test("a cap drop writes one line with the reason", async (t) => {
  const h = await setup(t, { maxPerCaller: 1 });
  const first = await h.open(h.tokens.ada);
  await h.open(h.tokens.ada);
  const drops = kind(h.lines(), "drop");
  assert.equal(drops.length, 1);
  assert.match(drops[0]!, new RegExp(`drop reason=cap caller=ada session=${first.slice(0, 8)} ageMs=0$`));
});

test("a revoke drop writes one line with the reason", async (t) => {
  const h = await setup(t);
  const token = h.restricted.mint("ada", "s1");
  const id = await h.open(token);
  h.restricted.revoke(token);
  const drops = kind(h.lines(), "drop");
  assert.equal(drops.length, 1);
  assert.match(drops[0]!, new RegExp(`drop reason=revoke caller=ada:restricted session=${id.slice(0, 8)} `));
});

test("a client close writes one line with the reason close", async (t) => {
  const h = await setup(t);
  const id = await h.open(h.tokens.dee);
  assert.equal((await h.send("DELETE", h.tokens.dee, id)).status, 200);
  const drops = kind(h.lines(), "drop");
  assert.equal(drops.length, 1);
  assert.match(drops[0]!, new RegExp(`drop reason=close caller=dee session=${id.slice(0, 8)} `));
});

test("a GET with an unknown session id writes one 404 line", async (t) => {
  const h = await setup(t);
  const res = await h.send("GET", h.tokens.cyd, "cafe0001-aaaa-bbbb-cccc-000000000001");
  assert.equal(res.status, 404);
  assert.deepEqual(h.lines(), ["2026-11-08T00:00:00.000Z 404 method=GET caller=cyd session=cafe0001"]);
});

test("a DELETE with an unknown session id writes one 404 line", async (t) => {
  const h = await setup(t);
  const res = await h.send("DELETE", h.tokens.cyd, "cafe0002-aaaa-bbbb-cccc-000000000002");
  assert.equal(res.status, 404);
  assert.deepEqual(h.lines(), ["2026-11-08T00:00:00.000Z 404 method=DELETE caller=cyd session=cafe0002"]);
});

test("a POST with an unknown session id writes one stateless line and no 404", async (t) => {
  const h = await setup(t);
  const res = await h.send("POST", h.tokens.cyd, "cafe0003-aaaa-bbbb-cccc-000000000003", CALL_BODY);
  assert.equal(res.status, 200);
  assert.deepEqual(h.lines(), ["2026-11-08T00:00:00.000Z stateless caller=cyd session=cafe0003"]);
});

test("a stale id after an idle drop writes the drop and then the stateless line", async (t) => {
  const h = await setup(t, { idleMs: 1000 });
  const id = await h.open(h.tokens.cyd);
  h.clock.at += 5000;
  assert.equal((await h.send("POST", h.tokens.cyd, id, CALL_BODY)).status, 200);
  assert.deepEqual(
    h.lines().map((l) => l.split(" ")[1]),
    ["drop", "stateless"],
  );
});

test("no line holds a token, a full session id, or a request body", async (t) => {
  const h = await setup(t, { idleMs: 1000, maxPerCaller: 1 });
  const token = h.restricted.mint("ada", "s1");
  const ids = [await h.open(h.tokens.ada), await h.open(h.tokens.ada), await h.open(token)];
  h.restricted.revoke(token);
  h.clock.at += 5000;
  await h.send("POST", h.tokens.ada, ids[1]!, CALL_BODY);
  await h.send("GET", h.tokens.ada, "abcdef12-3456-7890-abcd-ef1234567890");
  await h.send("POST", h.tokens.ada, "abcdef34-3456-7890-abcd-ef1234567890", CALL_BODY);
  const log = h.lines().join("\n");
  assert.ok(h.lines().length >= 5, log);
  for (const secret of [...Object.values(h.tokens), token, "BODYMARK-7731", "abcdef12-", "abcdef34-", ...ids]) {
    assert.ok(!log.includes(secret), `the log holds ${secret.slice(0, 8)}`);
  }
  for (const id of ids) assert.ok(log.includes(`session=${id.slice(0, 8)}`));
});

test("a client cannot add a line or a field through the session id", async (t) => {
  const h = await setup(t);
  await h.send("GET", h.tokens.cyd, "a b=c");
  const lines = h.lines();
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /^\S+ 404 method=GET caller=cyd session=a_b_c$/);
});

test("the log stops at 1 MiB, then starts again at the .1 file", (t) => {
  const home = tempHome();
  t.after(() => home.cleanup());
  const file = join(home.dir, "mcp-session.log");
  const log = sessionLog(file);
  const event = (n: number): SessionEvent => ({
    kind: "drop",
    reason: "cap",
    caller: `ext:${"x".repeat(200)}`,
    session: `${n}`.padStart(8, "0"),
    ageMs: n,
  });
  let n = 0;
  while (!existsSync(`${file}.1`)) {
    log(event(n++));
    assert.ok(n < 20_000, "the log never rolled");
  }
  assert.ok(statSync(`${file}.1`).size <= SESSION_LOG_MAX_BYTES);
  assert.ok(statSync(`${file}.1`).size > SESSION_LOG_MAX_BYTES - 400);
  assert.equal(readFileSync(file, "utf8").split("\n").filter(Boolean).length, 1);

  const first = readFileSync(`${file}.1`, "utf8");
  const more = n + 100;
  for (let i = 0; i < more; i++) log(event(n++));
  assert.ok(statSync(file).size <= SESSION_LOG_MAX_BYTES);
  assert.ok(statSync(`${file}.1`).size <= SESSION_LOG_MAX_BYTES);
  assert.notEqual(readFileSync(`${file}.1`, "utf8"), first, "the old file was replaced");
});

test("a log write error never throws", (t) => {
  const home = tempHome();
  t.after(() => home.cleanup());
  const log = sessionLog(join(home.dir, "no-such-folder", "mcp-session.log"));
  assert.doesNotThrow(() => log({ kind: "stateless", caller: "ada", session: "abcdef12" }));
});

test("a log that cannot be written does not fail the request", async (t) => {
  const home = tempHome();
  t.after(() => home.cleanup());
  const blocked = join(home.dir, "blocked");
  mkdirSync(blocked);
  const h = await setup(t, { log: sessionLog(blocked) });
  const res = await h.send("GET", h.tokens.cyd, "cafe0004-aaaa-bbbb-cccc-000000000004");
  assert.equal(res.status, 404);
  const ok = await h.send("POST", h.tokens.cyd, "cafe0005-aaaa-bbbb-cccc-000000000005", CALL_BODY);
  assert.equal(ok.status, 200);
});
