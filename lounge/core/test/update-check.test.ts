import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defaultConfig, loadConfig } from "../src/config.ts";
import { checkLatest, compareSemver, LATEST_URL, type Fetch } from "../src/update/check.ts";
import { tempHome } from "./helpers.ts";

const ASSET = { name: "minimal-agent-kit-lounge-0.10.0-windows.zip", browser_download_url: "https://example.test/a.zip" };

function reply(status: number, body: unknown): Fetch {
  return async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
}

function release(tag: string): Fetch {
  return reply(200, { tag_name: tag, assets: [ASSET] });
}

const check = (fetch: Fetch, current = "0.9.0") => checkLatest({ fetch, current, enabled: true });

test("c3_1: newer tag is available", async () => {
  assert.deepEqual(await check(release("v0.10.0")), {
    state: "available",
    version: "0.10.0",
    assets: [{ name: ASSET.name, url: ASSET.browser_download_url }],
  });
});

test("c3_1: equal tag is none", async () => {
  assert.deepEqual(await check(release("v0.9.0")), { state: "none" });
});

test("c3_1: older tag is none", async () => {
  assert.deepEqual(await check(release("v0.8.9")), { state: "none" });
  assert.deepEqual(await check(release("v0.9.0"), "0.10.0"), { state: "none" });
});

test("c3_1: tag that is not v plus semver is error", async () => {
  for (const tag of ["0.10.0", "v0.10", "v0.10.0-rc1", "latest"]) {
    assert.deepEqual(await check(release(tag)), { state: "error", reason: "tag" }, tag);
  }
});

test("c3_1: 404 means no release", async () => {
  assert.deepEqual(await check(reply(404, { message: "Not Found" })), { state: "none" });
});

test("c3_1: 403 rate limit is error", async () => {
  assert.deepEqual(await check(reply(403, { message: "rate limit" })), { state: "error", reason: "http 403" });
});

test("c3_1: network failure is error", async () => {
  const down: Fetch = async () => {
    throw new TypeError("fetch failed");
  };
  assert.deepEqual(await check(down), { state: "error", reason: "network" });
});

test("c3_1: unreadable body is error", async () => {
  assert.deepEqual(await check(reply(200, "<html>")), { state: "error", reason: "body" });
});

test("c3_1: the request names the releases endpoint and a user agent", async () => {
  const seen: { url: string; headers: Record<string, string> }[] = [];
  const spy: Fetch = async (url, init) => {
    seen.push({ url, headers: init?.headers as Record<string, string> });
    return release("v0.9.0")(url, init);
  };
  await check(spy);
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.url, LATEST_URL);
  assert.equal(seen[0]!.headers["User-Agent"], "agent-lounge");
});

test("c3_1: compareSemver orders by number, not text", () => {
  assert.equal(compareSemver("0.10.0", "0.9.0"), 1);
  assert.equal(compareSemver("1.0.0", "1.0.0"), 0);
  assert.equal(compareSemver("0.9.1", "0.9.2"), -1);
});

test("c3_2: config update.check false skips the fetch", async (t) => {
  const home = tempHome();
  t.after(home.cleanup);
  mkdirSync(home.dir, { recursive: true });
  writeFileSync(join(home.dir, "config.json"), JSON.stringify({ update: { check: false } }));
  const config = loadConfig(home.dir);
  let calls = 0;
  const spy: Fetch = async (url, init) => {
    calls += 1;
    return release("v0.10.0")(url, init);
  };
  assert.deepEqual(await checkLatest({ fetch: spy, current: "0.9.0", enabled: config.update.check }), { state: "off" });
  assert.equal(calls, 0);
});

test("c3_2: update.check defaults to true and a non-boolean is rejected", (t) => {
  const home = tempHome();
  t.after(home.cleanup);
  assert.equal(defaultConfig().update.check, true);
  assert.equal(loadConfig(home.dir).update.check, true);
  writeFileSync(join(home.dir, "config.json"), JSON.stringify({ update: { check: "no" } }));
  assert.throws(() => loadConfig(home.dir), /invalid update\.check/);
});
