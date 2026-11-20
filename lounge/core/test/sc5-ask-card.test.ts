import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { startCore } from "../src/api/http.ts";
import { tempHome } from "./helpers.ts";

// The kit hook, as the harness runs it.
const HOOK = resolve(import.meta.dirname, "..", "..", "..", "core", "guard", "guard.js");
const ASK = { tool_name: "PowerShell", tool_input: { command: "Remove-Item -Recurse E:\\projects\\x\\src" }, cwd: "E:\\projects\\x" };
const SAFE = { tool_name: "PowerShell", tool_input: { command: "ls" }, cwd: "E:\\projects\\x" };

function runHook(env: Record<string, string>, event: unknown): Promise<string> {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [HOOK], { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "inherit"] });
    let out = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (d: string) => (out += d));
    child.on("error", fail);
    child.on("close", () => done(out));
    child.stdin.end(JSON.stringify(event));
  });
}

function decisionOf(out: string): string | undefined {
  if (!out) return undefined;
  return (JSON.parse(out) as { hookSpecificOutput: { permissionDecision: string } }).hookSpecificOutput.permissionDecision;
}

test("SC5: the kit hook posts an ask call and an approval card shows in the queue", async (t) => {
  const home = tempHome();
  const core = await startCore({ home: home.dir, port: 0, approvalMs: 10_000 });
  t.after(async () => {
    await core.close();
    home.cleanup();
  });
  const tokens = JSON.parse(readFileSync(join(home.dir, "tokens.json"), "utf8")) as Record<string, string>;
  const api = (path: string, init: RequestInit = {}) =>
    fetch(core.url + path, { ...init, headers: { "content-type": "application/json", authorization: `Bearer ${tokens.owner}` } });
  const env = { LOUNGE_GUARD_URL: core.url, LOUNGE_GUARD_TOKEN: tokens.ada! };

  // A safe call needs no card.
  assert.equal(decisionOf(await runHook(env, SAFE)), "allow");
  const idle = (await (await api("/api/guard")).json()) as { pending: unknown[] };
  assert.deepEqual(idle.pending, []);

  const asked = runHook(env, ASK);
  let card: { id: string; summary: string } | undefined;
  for (let i = 0; i < 300 && card === undefined; i++) {
    const g = (await (await api("/api/guard")).json()) as { pending: { id: string; summary: string }[] };
    card = g.pending[0];
    if (card === undefined) await new Promise((r) => setTimeout(r, 10));
  }
  assert.ok(card, "an approval card shows in the queue");
  assert.match(card.summary, /Remove-Item -Recurse/);

  const answer = await api(`/api/guard/approvals/${card.id}`, { method: "POST", body: JSON.stringify({ allow: true }) });
  assert.equal(answer.status, 200);
  assert.equal(decisionOf(await asked), "allow");
});

test("SC5: a denied card makes the hook deny", async (t) => {
  const home = tempHome();
  const core = await startCore({ home: home.dir, port: 0, approvalMs: 10_000 });
  t.after(async () => {
    await core.close();
    home.cleanup();
  });
  const tokens = JSON.parse(readFileSync(join(home.dir, "tokens.json"), "utf8")) as Record<string, string>;
  const api = (path: string, init: RequestInit = {}) =>
    fetch(core.url + path, { ...init, headers: { "content-type": "application/json", authorization: `Bearer ${tokens.owner}` } });
  const asked = runHook({ LOUNGE_GUARD_URL: core.url, LOUNGE_GUARD_TOKEN: tokens.ada! }, ASK);
  let id: string | undefined;
  for (let i = 0; i < 300 && id === undefined; i++) {
    const g = (await (await api("/api/guard")).json()) as { pending: { id: string }[] };
    id = g.pending[0]?.id;
    if (id === undefined) await new Promise((r) => setTimeout(r, 10));
  }
  assert.ok(id, "an approval card shows in the queue");
  await api(`/api/guard/approvals/${id}`, { method: "POST", body: JSON.stringify({ allow: false }) });
  assert.equal(decisionOf(await asked), "deny");
});
