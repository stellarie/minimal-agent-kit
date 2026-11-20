import { test, type TestContext } from "node:test";
import { join } from "node:path";
import assert from "node:assert/strict";
import type { Adapter } from "../src/adapters/types.ts";
import { defaultConfig, SEED_AGENTS, type Agent } from "../src/config.ts";
import { openDb } from "../src/db/db.ts";
import { Reachability } from "../src/lounge/reachability.ts";
import { FakeTimers, adaptersOf, tempHome, testRoster } from "./helpers.ts";

const tick = () => new Promise((resolve) => setImmediate(resolve));

function rosterOf(t: TestContext) {
  const home = tempHome();
  const db = openDb(join(home.dir, "lounge.db"));
  t.after(() => {
    db.close();
    home.cleanup();
  });
  return testRoster(db, defaultConfig());
}

function probed(results: Partial<Record<Agent, boolean>>, calls: Agent[]): Record<Agent, Adapter> {
  const out = {} as Record<Agent, Adapter>;
  for (const agent of SEED_AGENTS) {
    out[agent] = {
      name: "claude",
      available: async () => {
        calls.push(agent);
        return results[agent] ? { ok: true } : { ok: false, reason: "down" };
      },
      chatTurn: async () => ({ kind: "pass" }),
    };
  }
  return out;
}

test("reachability: probes enabled adapters at start and each interval", async (t) => {
  const timers = new FakeTimers();
  const results: Partial<Record<Agent, boolean>> = { ada: true, cyd: false };
  const calls: Agent[] = [];
  const logs: string[] = [];
  const reach = new Reachability({
    adapters: adaptersOf(probed(results, calls)),
    roster: rosterOf(t),
    intervalMs: 60_000,
    timers,
    log: (line) => logs.push(line),
  });
  reach.start();
  await tick();
  assert.deepEqual([...reach.reachable()], ["ada"]);
  assert.deepEqual(calls.sort(), ["ada", "cyd"], "bea and dee are disabled");
  assert.deepEqual([...timers.pending.values()].map((p) => p.ms), [60_000]);

  results.ada = false;
  results.cyd = true;
  timers.fireAll();
  await tick();
  assert.deepEqual([...reach.reachable()], ["cyd"]);
  timers.fireAll();
  await tick();
  assert.deepEqual(logs, ["cyd unreachable: down", "ada unreachable: down"], "a reason logs once");

  reach.stop();
  assert.equal(timers.pending.size, 0);
});

test("reachability: a throwing probe counts as unreachable", async (t) => {
  const adapters = probed({ ada: true }, []);
  adapters.ada = { ...adapters.ada, available: async () => Promise.reject(new Error("boom")) };
  const reach = new Reachability({ adapters: adaptersOf(adapters), roster: rosterOf(t), intervalMs: 1000 });
  await reach.probe();
  assert.equal(reach.reachable().size, 0);
});
