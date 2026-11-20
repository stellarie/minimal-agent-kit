import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ApiError, createHttpClient } from "./api.ts";

test("the live client reads and writes the block-asks setting", async (t) => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const on = init?.method === "PUT" ? JSON.parse(String(init.body)).enabled : false;
    return new Response(JSON.stringify({ enabled: on }), { status: 200 });
  }) as typeof fetch;
  const client = createHttpClient("tok");
  assert.deepEqual(await client.getBlockAsks(), { enabled: false });
  assert.equal(calls[0]!.url, "/api/guard/block-asks");
  assert.equal(calls[0]!.init?.method, undefined);
  assert.deepEqual(await client.setBlockAsks(true), { enabled: true });
  assert.equal(calls[1]!.url, "/api/guard/block-asks");
  assert.equal(calls[1]!.init!.method, "PUT");
  assert.deepEqual(JSON.parse(String(calls[1]!.init!.body)), { enabled: true });
  assert.equal((calls[1]!.init!.headers as Record<string, string>)["Content-Type"], "application/json");
  assert.equal((calls[1]!.init!.headers as Record<string, string>).Authorization, "Bearer tok");
});

test("the live client surfaces a rejected block-asks write", async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ error: "bad_request", message: "enabled must be a boolean" }), { status: 400 })) as typeof fetch;
  await assert.rejects(createHttpClient("tok").setBlockAsks(true), (err: unknown) => {
    assert.ok(err instanceof ApiError);
    assert.equal(err.status, 400);
    return true;
  });
});

test("the Permissions view shows the block toggle below the rule toggle", () => {
  const panel = readFileSync(new URL("../components/PermissionsPanel.svelte", import.meta.url), "utf8");
  assert.ok(panel.indexOf("<GuardRuleAsks") !== -1 && panel.indexOf("<GuardRuleAsks") < panel.indexOf("<GuardBlockAsks"));
  const toggle = readFileSync(new URL("../components/GuardBlockAsks.svelte", import.meta.url), "utf8");
  for (const part of ["client.getBlockAsks()", "client.setBlockAsks(next)", "The floor still denies", "dangerous card"]) {
    assert.ok(toggle.includes(part), part);
  }
  assert.ok(!/always/i.test(toggle));
});
