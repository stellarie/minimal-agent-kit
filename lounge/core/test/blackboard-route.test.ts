import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startCore } from "../src/api/http.ts";
import { ensureTokens } from "../src/auth/tokens.ts";
import { unavailableAdapter } from "../src/adapters/stub.ts";
import { fakeKinds, tempHome, SEED_CALLERS } from "./helpers.ts";

const TASK = "---\nstatus: review\nowner: ada\nupdated: 2026-11-21\n---\n\n# Ship it\n\n## Work Items\n- [x] W1: done thing | owner: ada | result: abc1234\n";

async function setup(t: TestContext) {
  const home = tempHome();
  const project = mkdtempSync(join(tmpdir(), "board-route-"));
  const runtimes = fakeKinds(() => unavailableAdapter("claude", "test stub")).filter((k) => k.id === "claude-code");
  const core = await startCore({ home: home.dir, port: 0, runtimes });
  t.after(async () => {
    await core.close();
    home.cleanup();
    rmSync(project, { recursive: true, force: true, maxRetries: 5 });
  });
  const tokens = ensureTokens(home.dir, SEED_CALLERS);
  const api = (path: string, init: RequestInit & { as?: "owner" | null } = {}) => {
    const { as = "owner", ...rest } = init;
    const headers = new Headers(rest.headers);
    headers.set("content-type", "application/json");
    if (as) headers.set("authorization", `Bearer ${tokens[as]}`);
    return fetch(core.url + path, { ...rest, headers });
  };
  const res = await api("/api/threads", {
    method: "POST",
    body: JSON.stringify({ channel: "lounge", title: "Board", brief: "go", lead: "ada", cwd: project }),
  });
  assert.equal(res.status, 201);
  const thread = (await res.json()) as { id: string };
  return { api, project, thread };
}

test("SC29: GET /api/threads/:id/blackboard gives an empty board when the folder is absent", async (t) => {
  const h = await setup(t);
  const res = await h.api(`/api/threads/${h.thread.id}/blackboard`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { tasks: [] });
});

test("c14_2_valid_route: the route reads the thread folder and shows a task", async (t) => {
  const h = await setup(t);
  mkdirSync(join(h.project, ".kit", "tasks"), { recursive: true });
  writeFileSync(join(h.project, ".kit", "tasks", "ship.md"), TASK);
  const body = (await (await h.api(`/api/threads/${h.thread.id}/blackboard`)).json()) as {
    tasks: { name: string; ok: boolean; status: string; items: { id: string; owner: string }[] }[];
  };
  assert.equal(body.tasks.length, 1);
  assert.deepEqual(
    [body.tasks[0]!.name, body.tasks[0]!.ok, body.tasks[0]!.status, body.tasks[0]!.items[0]!.owner],
    ["ship.md", true, "review", "ada"],
  );
});

test("SC30: the route shows a malformed file as raw text with a warning", async (t) => {
  const h = await setup(t);
  mkdirSync(join(h.project, ".kit", "tasks"), { recursive: true });
  writeFileSync(join(h.project, ".kit", "tasks", "bad.md"), "oops");
  const body = (await (await h.api(`/api/threads/${h.thread.id}/blackboard`)).json()) as {
    tasks: { ok: boolean; raw?: string; warning?: string }[];
  };
  assert.deepEqual([body.tasks[0]!.ok, body.tasks[0]!.raw], [false, "oops"]);
  assert.match(body.tasks[0]!.warning ?? "", /\S/);
});

test("c14_1_route_ids: the route takes no path, so an id that climbs or holds a path is an unknown thread", async (t) => {
  const h = await setup(t);
  for (const id of ["thread-none", "lounge", "..%2F..", "%2e%2e", encodeURIComponent(h.project), "%E0%A4%A"]) {
    const res = await h.api(`/api/threads/${id}/blackboard`);
    assert.ok(res.status === 404 || res.status === 400, `${id}: ${res.status}`);
  }
  assert.equal((await h.api("/api/threads/thread-none/blackboard")).status, 404);
  assert.equal((await h.api("/api/threads/lounge/blackboard")).status, 404);
});

test("c14_1_route_read_only: the route reads only: a write method is refused", async (t) => {
  const h = await setup(t);
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    assert.equal((await h.api(`/api/threads/${h.thread.id}/blackboard`, { method })).status, 405, method);
  }
});

test("the route needs the owner token", async (t) => {
  const h = await setup(t);
  assert.equal((await h.api(`/api/threads/${h.thread.id}/blackboard`, { as: null })).status, 401);
});
