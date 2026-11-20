import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { AdapterPool } from "../src/adapters/index.ts";
import { coreKinds } from "../src/adapters/runtimes.ts";
import { defaultConfig } from "../src/config.ts";
import { openDb } from "../src/db/db.ts";
import type { RuntimeContext } from "../src/roster/types.ts";
import { tempHome, testRoster } from "./helpers.ts";

test("core kinds: only runtimes that need no install", () => {
  assert.deepEqual(coreKinds().map((k) => k.id), ["stub"]);
});

test("stub adapter: it replies with its fixed text, and an empty reply passes", async (t) => {
  const home = tempHome();
  const db = openDb(join(home.dir, "lounge.db"));
  t.after(() => {
    db.close();
    home.cleanup();
  });
  const roster = testRoster(db, defaultConfig(), coreKinds());
  roster.add({ id: "nana", runtime: "stub", options: { reply: "fixed text" } });
  roster.add({ id: "mika", runtime: "stub" });
  const ctx = { home: "C:/lounge", mcpUrl: () => "http://127.0.0.1:1/mcp" } as RuntimeContext;
  const adapters = new AdapterPool(roster, () => coreKinds(), ctx);
  const signal = new AbortController().signal;
  assert.deepEqual(await adapters.get("nana")!.available(), { ok: true });
  assert.deepEqual(await adapters.get("nana")!.chatTurn({} as never, signal), { kind: "post", text: "fixed text" });
  assert.deepEqual(await adapters.get("mika")!.chatTurn({} as never, signal), { kind: "pass" });
});

test("the pool has no adapter for a runtime that no plugin loads", (t) => {
  const home = tempHome();
  const db = openDb(join(home.dir, "lounge.db"));
  t.after(() => {
    db.close();
    home.cleanup();
  });
  // Bea sits on codex, which the core no longer holds.
  const roster = testRoster(db, defaultConfig(), coreKinds());
  const ctx = { home: "C:/lounge", mcpUrl: () => "http://127.0.0.1:1/mcp" } as RuntimeContext;
  const adapters = new AdapterPool(roster, () => coreKinds(), ctx);
  assert.equal(roster.get("bea")!.runtime, "codex");
  assert.equal(adapters.get("bea"), undefined);
  assert.equal(roster.runtimeReason("bea"), "runtime codex needs a plugin");
  assert.equal(roster.runtimeReason("nobody"), undefined);
});
