import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ApiError, RULES_MAX_BYTES, createHttpClient } from "./api.ts";
import { rulesState } from "./rules.ts";

test("the byte limit is the core limit", () => {
  const file = new URL("../../../core/src/api/http.ts", import.meta.url);
  const match = /const MAX_RULES_BYTES = (\d+) \* 1024;/.exec(readFileSync(file, "utf8"));
  assert.ok(match, "core MAX_RULES_BYTES not found");
  assert.equal(RULES_MAX_BYTES, Number(match[1]) * 1024);
});

test("rulesState: save is off for an unchanged or an oversize text", () => {
  assert.deepEqual(rulesState("", ""), { bytes: 0, over: false, dirty: false, canSave: false });
  assert.equal(rulesState("a", "").canSave, true);
  assert.equal(rulesState("a", "a").canSave, false);
  assert.equal(rulesState("a".repeat(RULES_MAX_BYTES), "").canSave, true);
  const over = rulesState("a".repeat(RULES_MAX_BYTES + 1), "");
  assert.deepEqual([over.over, over.canSave], [true, false]);
});

test("rulesState counts UTF-8 bytes, not characters", () => {
  const text = "あ".repeat(Math.floor(RULES_MAX_BYTES / 3) + 1);
  assert.ok(text.length < RULES_MAX_BYTES);
  assert.equal(rulesState(text, "").over, true);
  assert.equal(rulesState("あ".repeat(Math.floor(RULES_MAX_BYTES / 3)), "").over, false);
});

test("the live client sends the rules as written and shows the core message on a refusal", async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  const bodies: string[] = [];
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    bodies.push(String(init?.body));
    const text: string = JSON.parse(String(init?.body)).text;
    if (text.length > RULES_MAX_BYTES) {
      return new Response(JSON.stringify({ error: "bad_rules", message: "the rules are too long" }), { status: 400 });
    }
    return new Response(JSON.stringify({ text }), { status: 200 });
  }) as typeof fetch;
  const client = createHttpClient("tok");
  const text = "  End every message with a summary.\n";
  assert.deepEqual(await client.saveLoungeRules(text), { text });
  assert.deepEqual(JSON.parse(bodies[0]!), { text });
  await assert.rejects(client.saveLoungeRules("a".repeat(RULES_MAX_BYTES + 1)), (err: unknown) => {
    assert.ok(err instanceof ApiError);
    assert.equal(err.message, "the rules are too long");
    return true;
  });
});
