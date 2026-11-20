import { test } from "node:test";
import assert from "node:assert/strict";
import { startCore } from "../src/api/http.ts";
import { ensureTokens } from "../src/auth/tokens.ts";
import { unavailableAdapter } from "../src/adapters/stub.ts";
import { fakeKinds, tempHome, SEED_CALLERS } from "./helpers.ts";

test("SC23: GET /api/threads/:id/tree gives the thread tree, and the stop route stops the tree", async (t) => {
  const home = tempHome();
  const runtimes = fakeKinds(() => unavailableAdapter("claude", "test stub")).filter((k) => k.id === "claude-code");
  const core = await startCore({ home: home.dir, port: 0, runtimes });
  t.after(async () => {
    await core.close();
    home.cleanup();
  });
  const tokens = ensureTokens(home.dir, SEED_CALLERS);
  const api = (path: string, init: RequestInit = {}) =>
    fetch(core.url + path, {
      ...init,
      headers: { "content-type": "application/json", authorization: `Bearer ${tokens.owner}` },
    });
  const made = await api("/api/threads", {
    method: "POST",
    body: JSON.stringify({ channel: "lounge", title: "Root", brief: "go", lead: "ada" }),
  });
  const top = (await made.json()) as { id: string };
  const res = await api(`/api/threads/${top.id}/tree`);
  assert.equal(res.status, 200);
  const tree = (await res.json()) as { id: string; lead: string; stopped: boolean; children: unknown[] };
  assert.deepEqual([tree.id, tree.lead, tree.stopped, tree.children], [top.id, "ada", false, []]);
  assert.equal((await api(`/api/threads/${top.id}/stop`, { method: "POST" })).status, 200);
  const after = (await (await api(`/api/threads/${top.id}/tree`)).json()) as { stopped: boolean };
  assert.equal(after.stopped, true);
  assert.equal((await api("/api/threads/thread-00000000/tree")).status, 404);
});
