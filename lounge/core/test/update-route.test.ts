import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startCore } from "../src/api/http.ts";
import type { Fetch } from "../src/update/check.ts";
import type { stageRelease } from "../src/update/stage.ts";
import { tempHome } from "./helpers.ts";

const NEXT = "999.0.0";

class FakeInterval {
  active = new Map<number, () => void>();
  #next = 1;
  setInterval(fn: () => void): unknown {
    this.active.set(this.#next, fn);
    return this.#next++;
  }
  clearInterval(handle: unknown): void {
    this.active.delete(handle as number);
  }
  fire(): void {
    for (const fn of [...this.active.values()]) fn();
  }
}

async function boot(t: TestContext, opts: { withUpdate?: boolean; tag?: string } = {}) {
  const home = tempHome();
  const timers = new FakeInterval();
  const calls = { fetch: 0, stage: 0, apply: 0 };
  let applied: () => void = () => {};
  const applyCalled = new Promise<void>((resolve) => (applied = resolve));
  const releaseFetch: Fetch = async () => {
    calls.fetch += 1;
    return new Response(JSON.stringify({ tag_name: `v${opts.tag ?? NEXT}`, assets: [] }));
  };
  const stage: typeof stageRelease = async ({ release, home: root }) => {
    calls.stage += 1;
    const dir = join(root, "updates", release.version);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "ready.json"), JSON.stringify({ version: release.version, root: join(dir, "root") }));
    return { state: "ready", version: release.version };
  };
  const update =
    opts.withUpdate === false
      ? undefined
      : {
          installRoot: home.dir,
          everyMs: 21_600_000,
          fetch: releaseFetch,
          stage,
          timers,
          onApply: () => {
            calls.apply += 1;
            applied();
          },
        };
  const core = await startCore({ home: home.dir, port: 0, schedule: false, update });
  t.after(async () => {
    await core.close();
    home.cleanup();
  });
  const tokens = JSON.parse(readFileSync(join(home.dir, "tokens.json"), "utf8")) as Record<string, string>;
  const api = (path: string, init: RequestInit & { as?: string } = {}) => {
    const { as = "owner", ...rest } = init;
    return fetch(core.url + path, { ...rest, headers: { authorization: `Bearer ${tokens[as]}` } });
  };
  const status = async () => (await (await api("/api/update")).json()) as { state: string; version?: string; current: string };
  const until = async (state: string) => {
    for (let i = 0; i < 200; i++) {
      const s = await status();
      if (s.state === state) return s;
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.fail(`state never became ${state}`);
  };
  return { home, api, calls, timers, applyCalled, status, until, core };
}

test("c5_2: GET /api/update shows an available release after the first check", async (t) => {
  const h = await boot(t);
  const s = await h.until("available");
  assert.equal(s.version, NEXT);
  assert.equal(h.calls.fetch, 1);
});

test("c5_2: the check runs again on every interval tick", async (t) => {
  const h = await boot(t, { tag: "0.0.1" });
  await h.until("none");
  assert.equal(h.timers.active.size, 1);
  h.timers.fire();
  for (let i = 0; i < 100 && h.calls.fetch < 2; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(h.calls.fetch, 2);
});

test("c5_2: the check timer stops on close", async (t) => {
  const h = await boot(t);
  await h.until("available");
  assert.equal(h.timers.active.size, 1);
  await h.core.close();
  assert.equal(h.timers.active.size, 0);
});

test("c5_2: without the update option the state is off and nothing is fetched", async (t) => {
  const h = await boot(t, { withUpdate: false });
  assert.equal((await h.status()).state, "off");
  assert.equal(h.calls.fetch, 0);
  assert.equal((await h.api("/api/update/download", { method: "POST" })).status, 409);
});

test("c5_1: update routes need the owner token", async (t) => {
  const h = await boot(t);
  await h.until("available");
  for (const [path, method] of [
    ["/api/update", "GET"],
    ["/api/update/download", "POST"],
    ["/api/update/apply", "POST"],
  ] as const) {
    assert.equal((await h.api(path, { method, as: "ada" })).status, 403, path);
  }
  assert.equal(h.calls.stage, 0);
  assert.equal(h.calls.apply, 0);
  assert.equal(existsSync(join(h.home.dir, "updates", "apply.json")), false);
});

test("c5_1: an available release is not downloaded until the owner asks", async (t) => {
  const h = await boot(t);
  await h.until("available");
  assert.equal(h.calls.stage, 0);
  const res = await h.api("/api/update/download", { method: "POST" });
  assert.equal(res.status, 202);
  assert.equal((await h.until("ready")).version, NEXT);
  assert.equal(h.calls.stage, 1);
  assert.equal(existsSync(join(h.home.dir, "updates", "apply.json")), false);
});

test("c5_1: download is 409 unless a release is available", async (t) => {
  const h = await boot(t, { tag: "0.0.1" });
  await h.until("none");
  assert.equal((await h.api("/api/update/download", { method: "POST" })).status, 409);
  assert.equal(h.calls.stage, 0);
});

test("c5_1: apply is 409 and writes nothing before the release is staged", async (t) => {
  const h = await boot(t);
  await h.until("available");
  assert.equal((await h.api("/api/update/apply", { method: "POST" })).status, 409);
  assert.equal(existsSync(join(h.home.dir, "updates", "apply.json")), false);
  assert.equal(h.calls.apply, 0);
});

test("c5_1: POST /api/update/apply with ready.json writes apply.json and calls onApply", async (t) => {
  const h = await boot(t);
  await h.until("available");
  await h.api("/api/update/download", { method: "POST" });
  await h.until("ready");
  const res = await h.api("/api/update/apply", { method: "POST" });
  assert.equal(res.status, 202);
  await h.applyCalled;
  const marker = JSON.parse(readFileSync(join(h.home.dir, "updates", "apply.json"), "utf8"));
  assert.deepEqual(marker, { version: NEXT, root: join(h.home.dir, "updates", NEXT, "root") });
  assert.equal(h.calls.apply, 1);
});
