import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { startCore } from "../src/api/http.ts";
import { replyAdapter } from "../src/adapters/stub.ts";
import { DEFAULT_POLICY } from "../src/guard/judge.ts";
import type { RuntimeKind } from "../src/roster/types.ts";
import { tempHome } from "./helpers.ts";

const CWD = "E:\\projects\\x";
const ASK = { tool: "PowerShell", input: { command: "Remove-Item -Recurse E:\\projects\\x\\src" }, cwd: CWD };
const KIND: RuntimeKind = {
  id: "claude-code",
  label: "Claude Code",
  efforts: () => ["low", "high"],
  models: () => ["haiku", "opus"],
  create: () => replyAdapter("claude-code", ""),
  toolModes: true,
};

async function start(home: { dir: string }) {
  const core = await startCore({ home: home.dir, port: 0, schedule: false, approvalMs: 10_000, runtimes: [KIND] });
  const tokens = JSON.parse(readFileSync(join(home.dir, "tokens.json"), "utf8")) as Record<string, string>;
  const api = (path: string, init: RequestInit & { as?: string } = {}) => {
    const { as = "owner", ...rest } = init;
    return fetch(core.url + path, { ...rest, headers: { "content-type": "application/json", authorization: `Bearer ${tokens[as]}` } });
  };
  const put = (path: string, body: unknown, as = "owner") => api(path, { method: "PUT", body: JSON.stringify(body), as });
  return { core, api, put };
}

async function setup(t: TestContext) {
  const home = tempHome();
  const first = await start(home);
  let live = first.core;
  t.after(async () => {
    await live.close();
    home.cleanup();
  });
  const restart = async () => {
    await live.close();
    const next = await start(home);
    live = next.core;
    return next;
  };
  return { ...first, restart };
}

test("c5_1: an agent token cannot read or set the guard mode or the judge", async (t) => {
  const h = await setup(t);
  for (const path of ["/api/guard/mode", "/api/guard/judge"]) {
    assert.equal((await h.api(path, { as: "ada" })).status, 403, path);
    assert.equal((await h.put(path, { mode: "bypass" }, "ada")).status, 403, path);
  }
  assert.equal(((await (await h.api("/api/guard/mode")).json()) as { mode: string }).mode, "normal");
});

test("c5_1: an unknown guard mode is a 400", async (t) => {
  const h = await setup(t);
  for (const body of [{ mode: "yolo" }, { mode: 3 }, {}, null]) {
    assert.equal((await h.put("/api/guard/mode", body)).status, 400, JSON.stringify(body));
  }
  assert.equal((await h.api("/api/guard/mode", { method: "POST", body: "{}" })).status, 405);
  assert.equal(((await (await h.api("/api/guard/mode")).json()) as { mode: string }).mode, "normal");
});

test("c5_1: the owner sets auto and reads it back, and each change is in the audit", async (t) => {
  const h = await setup(t);
  const res = await h.put("/api/guard/mode", { mode: "auto" });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { mode: "auto" });
  assert.deepEqual(await (await h.api("/api/guard/mode")).json(), { mode: "auto" });
  await h.put("/api/guard/mode", { mode: "bypass" });
  const { recent } = (await (await h.api("/api/guard")).json()) as { recent: { source: string; summary: string; outcome: string }[] };
  assert.deepEqual(recent.slice(0, 2).map((e) => [e.source, e.summary, e.outcome]), [
    ["guard-mode", "guard mode: bypass", "allowed"],
    ["guard-mode", "guard mode: auto", "allowed"],
  ]);
});

test("c5_1: bypass is normal after a core restart and auto stays auto", async (t) => {
  const h = await setup(t);
  await h.put("/api/guard/mode", { mode: "bypass" });
  const afterBypass = await h.restart();
  assert.deepEqual(await (await afterBypass.api("/api/guard/mode")).json(), { mode: "normal" });
  await afterBypass.put("/api/guard/mode", { mode: "auto" });
  const afterAuto = await h.restart();
  assert.deepEqual(await (await afterAuto.api("/api/guard/mode")).json(), { mode: "auto" });
});

test("c5_1: the judge route gives the default, lists the claude choices, and checks a save", async (t) => {
  const h = await setup(t);
  const first = (await (await h.api("/api/guard/judge")).json()) as Record<string, unknown>;
  assert.deepEqual(first, {
    runtime: "claude-code",
    model: "haiku",
    effort: "",
    policy: DEFAULT_POLICY,
    defaultPolicy: DEFAULT_POLICY,
    models: ["haiku", "opus"],
    efforts: ["low", "high"],
  });
  const saved = await h.put("/api/guard/judge", { runtime: "claude-code", model: "opus", effort: "low", policy: "" });
  assert.equal(saved.status, 200);
  const body = (await saved.json()) as { policy: string; defaultPolicy: string };
  assert.equal(body.policy, "");
  assert.equal(body.defaultPolicy, DEFAULT_POLICY);
  const bad = await h.put("/api/guard/judge", { runtime: "claude-code", model: "", effort: "", policy: "" });
  assert.equal(bad.status, 400);
  assert.equal(((await (await h.api("/api/guard/judge")).json()) as { model: string }).model, "opus");
});

// A claude on PATH that logs its arguments and says SAFE.
function fakeClaudeOnPath(t: TestContext): { calls(): { argv: string[] }[] } {
  const dir = mkdtempSync(join(tmpdir(), "judge-api-"));
  const log = join(dir, "calls.log");
  const body = `const fs = require("node:fs");
let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => (stdin += d));
process.stdin.on("end", () => {
  fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ argv: process.argv.slice(2), stdin }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "result", is_error: false, result: "SAFE" }));
});
`;
  if (process.platform === "win32") {
    const pkg = join(dir, "node_modules", "@anthropic-ai", "claude-code");
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, "cli.js"), body);
    writeFileSync(join(dir, "claude.cmd"), "@echo off\r\n");
  } else {
    writeFileSync(join(dir, "claude"), `#!/usr/bin/env node\n${body}`);
    chmodSync(join(dir, "claude"), 0o755);
  }
  const key = process.platform === "win32" && process.env.Path !== undefined ? "Path" : "PATH";
  const original = process.env[key];
  process.env[key] = `${dir}${delimiter}${original ?? ""}`;
  t.after(() => {
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  });
  return {
    calls: () => {
      try {
        return readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { argv: string[] });
      } catch {
        return [];
      }
    },
  };
}

test("c5_1: the owner saves a judge and the next auto check uses its model and effort", async (t) => {
  const claude = fakeClaudeOnPath(t);
  const h = await setup(t);
  await h.put("/api/guard/mode", { mode: "auto" });
  await h.put("/api/guard/judge", { runtime: "claude-code", model: "opus", effort: "low", policy: "SAFE: the lounge test marker" });
  const res = await h.api("/guard/check", { method: "POST", as: "ada", body: JSON.stringify(ASK) });
  assert.deepEqual(await res.json(), { decision: "allow", asked: false });
  const [call] = claude.calls();
  assert.ok(call, "the judge ran");
  const at = call.argv.indexOf("--model");
  assert.deepEqual(call.argv.slice(at, at + 4), ["--model", "opus", "--effort", "low"]);
  assert.ok(call.argv[call.argv.indexOf("--system-prompt") + 1]!.includes("SAFE: the lounge test marker"));
  await h.put("/api/guard/judge", { runtime: "claude-code", model: "haiku", effort: "", policy: "" });
  await h.api("/guard/check", { method: "POST", as: "ada", body: JSON.stringify(ASK) });
  assert.equal(claude.calls().length, 2, "a judge SAFE is not cached across a policy change");
  assert.ok(!claude.calls()[1]!.argv.includes("--effort"));
});
