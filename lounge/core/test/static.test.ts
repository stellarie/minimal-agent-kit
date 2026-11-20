import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { connect } from "node:net";
import { join } from "node:path";
import { startCore, type CoreHandle } from "../src/api/http.ts";
import { serveStatic } from "../src/api/static.ts";
import { ensureTokens } from "../src/auth/tokens.ts";
import { tempHome, SEED_CALLERS } from "./helpers.ts";

const INDEX_MARKER = "lounge index page";

function makeDist(home: string): string {
  const dist = join(home, "ui-dist");
  mkdirSync(join(dist, "assets"), { recursive: true });
  writeFileSync(join(dist, "index.html"), `<!doctype html><title>agent lounge</title><p>${INDEX_MARKER}</p>`);
  writeFileSync(join(dist, "assets", "index-abc123.js"), "console.log('lounge');");
  writeFileSync(join(dist, "assets", "index-abc123.css"), ".lounge{color:#f2497b}");
  return dist;
}

async function startWithDist(t: TestContext, uiDist?: string): Promise<{ core: CoreHandle; home: string; dist: string }> {
  const home = tempHome();
  const dist = uiDist ?? makeDist(home.dir);
  const core = await startCore({ home: home.dir, port: 0, uiDist: dist });
  t.after(async () => {
    await core.close();
    home.cleanup();
  });
  return { core, home: home.dir, dist };
}

function rawGet(port: number, target: string, method = "GET"): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1");
    let data = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      socket.write(`${method} ${target} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`);
    });
    socket.on("data", (chunk: string) => (data += chunk));
    socket.on("end", () => resolve(data));
    socket.on("error", reject);
  });
}

interface Captured {
  status: number;
  headers: Record<string, string>;
  body: string;
}

function fakeResponse(method = "GET"): { res: ServerResponse; seen: Captured } {
  const seen: Captured = { status: 0, headers: {}, body: "" };
  const res = {
    req: { method },
    writeHead(status: number, headers: Record<string, string>) {
      seen.status = status;
      Object.assign(seen.headers, headers);
      return res;
    },
    end(body?: string | Buffer) {
      seen.body = body === undefined ? "" : body.toString();
      return res;
    },
  };
  return { res: res as unknown as ServerResponse, seen };
}

test("the core serves index.html at the root", async (t) => {
  const { core } = await startWithDist(t);
  const res = await fetch(`${core.url}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /^text\/html/);
  assert.equal(res.headers.get("cache-control"), "no-cache");
  assert.match(await res.text(), new RegExp(INDEX_MARKER));
});

test("the core serves files under assets with an immutable cache", async (t) => {
  const { core } = await startWithDist(t);
  const js = await fetch(`${core.url}/assets/index-abc123.js`);
  assert.equal(js.status, 200);
  assert.match(js.headers.get("content-type") ?? "", /^text\/javascript/);
  assert.equal(js.headers.get("cache-control"), "max-age=31536000, immutable");
  assert.match(await js.text(), /console\.log/);

  const css = await fetch(`${core.url}/assets/index-abc123.css`);
  assert.equal(css.status, 200);
  assert.match(css.headers.get("content-type") ?? "", /^text\/css/);
});

test("a missing asset is a 404 and never falls back to index.html", async (t) => {
  const { core } = await startWithDist(t);
  const res = await fetch(`${core.url}/assets/missing.js`);
  assert.equal(res.status, 404);
  assert.doesNotMatch(await res.text(), new RegExp(INDEX_MARKER));
});

test("an unknown route falls back to index.html", async (t) => {
  const { core } = await startWithDist(t);
  const res = await fetch(`${core.url}/some/route`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /^text\/html/);
  assert.match(await res.text(), new RegExp(INDEX_MARKER));
});

test("the api namespace never falls back to index.html", async (t) => {
  const { core } = await startWithDist(t);
  const res = await fetch(`${core.url}/api/no-such-route`);
  assert.equal(res.status, 404);
  assert.doesNotMatch(await res.text(), new RegExp(INDEX_MARKER));
});

test("traversal requests never return tokens.json", async (t) => {
  const { core, home } = await startWithDist(t);
  const tokens = ensureTokens(home, SEED_CALLERS);
  const port = Number(new URL(core.url).port);

  for (const target of ["/../tokens.json", "/%2e%2e/tokens.json", "/..%2ftokens.json"]) {
    const raw = await rawGet(port, target);
    assert.doesNotMatch(raw, new RegExp(tokens.owner), target);
    assert.match(raw, /HTTP\/1\.1 (404|400|200)/);
  }
  const viaFetch = await fetch(`${core.url}/../tokens.json`);
  assert.doesNotMatch(await viaFetch.text(), new RegExp(tokens.owner));
});

test("serveStatic refuses a decoded path outside the root", async (t) => {
  const home = tempHome();
  t.after(() => home.cleanup());
  const dist = makeDist(home.dir);
  const tokens = ensureTokens(home.dir, SEED_CALLERS);

  for (const target of ["/../tokens.json", "/%2e%2e/tokens.json", "/assets/../../tokens.json", "/..%5Ctokens.json"]) {
    const { res, seen } = fakeResponse();
    assert.equal(serveStatic(dist, target, res), true, target);
    assert.equal(seen.status, 404, target);
    assert.doesNotMatch(seen.body, new RegExp(tokens.owner), target);
  }
});

test("a HEAD request sends the headers of the file", async (t) => {
  const { core } = await startWithDist(t);
  const port = Number(new URL(core.url).port);
  const raw = await rawGet(port, "/assets/index-abc123.js", "HEAD");
  assert.match(raw, /HTTP\/1\.1 200/);
  assert.match(raw, /content-length: \d+/i);
  assert.doesNotMatch(raw.split("\r\n\r\n")[1] ?? "", /console\.log/);
});

test("without a built ui the core explains how to build it", async (t) => {
  const home = tempHome();
  const core = await startCore({ home: home.dir, port: 0, uiDist: join(home.dir, "missing-dist") });
  t.after(async () => {
    await core.close();
    home.cleanup();
  });

  const res = await fetch(`${core.url}/`);
  assert.equal(res.status, 404);
  assert.match(res.headers.get("content-type") ?? "", /^application\/json/);
  const body = (await res.json()) as { error?: string; message?: string };
  assert.equal(body.error, "no_ui");
  assert.match(body.message ?? "", /npm --prefix ui run build/);
});

test("health stays available while the UI is missing", async (t) => {
  const home = tempHome();
  const core = await startCore({ home: home.dir, port: 0, uiDist: join(home.dir, "missing-dist") });
  t.after(async () => {
    await core.close();
    home.cleanup();
  });

  const res = await fetch(`${core.url}/health`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
});
