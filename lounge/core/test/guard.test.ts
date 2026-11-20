import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import type { Caller } from "../src/config.ts";
import { ensureTokens } from "../src/auth/tokens.ts";
import { startCore } from "../src/api/http.ts";
import { tempHome, SEED_CALLERS } from "./helpers.ts";
import { Guard } from "../src/guard/guard.ts";
import { Approvals } from "../src/guard/approvals.ts";
import { Audit } from "../src/guard/audit.ts";

// The kit hook, as the harness runs it.
const HOOK = resolve(import.meta.dirname, "..", "..", "..", "core", "guard", "guard.js");
const ASK = { tool: "PowerShell", input: { command: "Remove-Item -Recurse E:\\projects\\x\\src" }, cwd: "E:\\projects\\x" };
const BLOCK = { tool: "PowerShell", input: { command: "$home = 'x'; Remove-Item -Recurse -Force $home" }, cwd: "E:\\projects\\x" };
const SAFE = { tool: "Bash", input: { command: "ls" }, cwd: "E:\\projects\\x" };

async function setup(t: TestContext, approvalMs = 5_000) {
  const home = tempHome();
  const core = await startCore({ home: home.dir, port: 0, approvalMs });
  t.after(async () => {
    await core.close();
    home.cleanup();
  });
  const tokens = ensureTokens(home.dir, SEED_CALLERS);
  const api = (path: string, init: RequestInit & { as?: Caller } = {}) => {
    const { as = "owner", ...rest } = init;
    return fetch(core.url + path, {
      ...rest,
      headers: { "content-type": "application/json", authorization: `Bearer ${tokens[as]}` },
    });
  };
  const check = (body: unknown, as: Caller = "ada") =>
    api("/guard/check", { method: "POST", body: JSON.stringify(body), as });
  // The open approval, once the core lists it.
  const pending = async () => {
    for (let i = 0; i < 200; i++) {
      const g = (await (await api("/api/guard")).json()) as { pending: { id: string; summary: string }[] };
      if (g.pending.length) return g.pending[0]!;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error("no approval card");
  };
  const decideCard = (id: string, allow: boolean) =>
    api(`/api/guard/approvals/${id}`, { method: "POST", body: JSON.stringify({ allow }) });
  return { url: core.url, home: home.dir, tokens, api, check, pending, decideCard };
}

function runHook(env: Record<string, string>, stdin: string): Promise<string> {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [HOOK], { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "inherit"] });
    let out = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (d: string) => (out += d));
    child.on("error", fail);
    child.on("close", () => done(out));
    child.stdin.end(stdin);
  });
}

function decisionOf(out: string): string | undefined {
  if (!out) return undefined;
  return (JSON.parse(out) as { hookSpecificOutput: { permissionDecision: string } }).hookSpecificOutput.permissionDecision;
}

test("an ask holds the check until owner answers", async (t) => {
  const h = await setup(t);
  const allowed = h.check(ASK);
  const card = await h.pending();
  assert.match(card.summary, /Remove-Item -Recurse/);
  assert.equal((await h.decideCard(card.id, true)).status, 200);
  assert.deepEqual(await (await allowed).json(), { decision: "allow", asked: true });

  const denied = h.check(ASK);
  await h.decideCard((await h.pending()).id, false);
  const body = (await (await denied).json()) as { decision: string; reason: string };
  assert.equal(body.decision, "deny");
  assert.match(body.reason, /denied/);

  const g = (await (await h.api("/api/guard")).json()) as { recent: { outcome: string }[]; pending: unknown[] };
  assert.deepEqual(g.recent.map((e) => e.outcome), ["denied", "allowed"]);
  assert.deepEqual(g.pending, []);
});

test("a block never asks, a safe call passes, and nobody answering denies", async (t) => {
  const h = await setup(t, 200);
  const blocked = (await (await h.check(BLOCK)).json()) as { decision: string; asked: boolean };
  assert.deepEqual([blocked.decision, blocked.asked], ["deny", false]);
  assert.deepEqual(await (await h.check(SAFE)).json(), { decision: "allow", asked: false });
  const late = (await (await h.check(ASK)).json()) as { decision: string; reason: string };
  assert.equal(late.decision, "deny");
  assert.match(late.reason, /nobody answered/);
});

test("the check needs an agent token, and decide needs owner", async (t) => {
  const h = await setup(t);
  const bad = await fetch(`${h.url}/guard/check`, {
    method: "POST",
    headers: { authorization: "Bearer nope" },
    body: JSON.stringify(SAFE),
  });
  assert.equal(bad.status, 401);
  assert.equal((await h.check(SAFE, "owner")).status, 403);
  assert.equal((await h.api("/api/guard/approvals/x", { method: "POST", body: '{"allow":true}', as: "ada" })).status, 403);
  assert.equal((await h.decideCard("missing", true)).status, 404);
});

test("the kit hook fails closed and follows the core", async (t) => {
  const h = await setup(t);
  const env = { LOUNGE_GUARD_URL: h.url, LOUNGE_GUARD_TOKEN: h.tokens.ada };
  const hookInput = (x: typeof ASK) => JSON.stringify({ tool_name: x.tool, tool_input: x.input, cwd: x.cwd });

  assert.equal(decisionOf(await runHook(env, "not json")), "deny");
  // A queue that cannot answer denies an ask.
  assert.equal(decisionOf(await runHook({ ...env, LOUNGE_GUARD_URL: "http://127.0.0.1:1" }, hookInput(ASK))), "deny");
  // A lounge turn with no token denies an ask.
  assert.equal(decisionOf(await runHook({ ...env, LOUNGE_GUARD_TOKEN: "" }, hookInput(ASK))), "deny");
  // Outside a lounge turn a safe call prints nothing.
  assert.equal(await runHook({ LOUNGE_GUARD_URL: "", LOUNGE_GUARD_TOKEN: "" }, hookInput(SAFE)), "");
  // The rules decide a safe call and a block without the core.
  assert.equal(decisionOf(await runHook(env, hookInput(SAFE))), "allow");
  assert.equal(decisionOf(await runHook(env, hookInput(BLOCK))), "deny");

  const asked = runHook(env, hookInput(ASK));
  await h.decideCard((await h.pending()).id, true);
  assert.equal(decisionOf(await asked), "allow");
});

test("rule asks can be turned off; blocks still deny", async (t) => {
  const h = await setup(t, 200);
  const state = async () => (await (await h.api("/api/guard/rule-asks")).json()) as { enabled: boolean };
  const put = (body: unknown, as?: Caller) =>
    h.api("/api/guard/rule-asks", { method: "PUT", body: JSON.stringify(body), ...(as ? { as } : {}) });
  assert.deepEqual(await state(), { enabled: true });

  assert.equal((await put({ enabled: "no" })).status, 400);
  assert.equal((await put({ enabled: false }, "ada")).status, 403);
  assert.deepEqual(await state(), { enabled: true });

  assert.deepEqual(await (await put({ enabled: false })).json(), { enabled: false });
  assert.deepEqual(await (await h.check(ASK)).json(), { decision: "allow", asked: false });
  const blocked = (await (await h.check(BLOCK)).json()) as { decision: string; asked: boolean };
  assert.deepEqual([blocked.decision, blocked.asked], ["deny", false]);
  const g = (await (await h.api("/api/guard")).json()) as { recent: { outcome: string; reason: string }[] };
  assert.ok(g.recent.some((e) => e.outcome === "allowed" && /rule asks are off/.test(e.reason)));

  assert.deepEqual(await (await put({ enabled: true })).json(), { enabled: true });
  const late = (await (await h.check(ASK)).json()) as { decision: string; reason: string };
  assert.equal(late.decision, "deny");
  assert.match(late.reason, /nobody answered/);
});

// A guard with rule asks off and a short card time.
function offGuard(t: TestContext, plugins: { plugin: string; fn: () => unknown }[] = []) {
  const home = tempHome();
  t.after(() => home.cleanup());
  const guard = new Guard({
    home: home.dir,
    approvals: new Approvals({ timeoutMs: 50 }),
    audit: new Audit(home.dir),
    plugins: () => plugins,
    ruleAsks: () => false,
  });
  return { home: home.dir, guard };
}

test("with rule asks off, a plugin ask on the same call still opens a card", async (t) => {
  const { guard } = offGuard(t, [{ plugin: "p", fn: () => ({ verdict: "ask", reason: "plugin says ask" }) }]);
  const action = guard.action(ASK.tool, ASK.input, ASK.cwd);
  const plain = await guard.check("ada", action);
  assert.deepEqual([plain.decision, plain.asked], ["deny", true]);
  assert.match(plain.reason ?? "", /nobody answered/);
  const failing = offGuard(t, [{ plugin: "q", fn: () => { throw new Error("boom"); } }]);
  const r = await failing.guard.check("ada", action);
  assert.deepEqual([r.decision, r.asked], ["deny", true]);
});

test("an approval card keeps a 32000 character write whole", async () => {
  const approvals = new Approvals({ timeoutMs: 50 });
  const summary = `E:/projects/x/a.txt\n${"x".repeat(32_000)}\n[cut]`;
  const done = approvals.request({ agent: "nana", tool: "Write", summary, reason: "check" });
  assert.equal(approvals.pending()[0]!.summary, summary);
  const huge = "y".repeat(50_000);
  const next = approvals.request({ agent: "nana", tool: "Bash", summary: huge, reason: "check" });
  assert.match(approvals.pending()[1]!.summary, /\[cut: \d+ more characters\]$/);
  assert.equal(await done, "timeout");
  assert.equal(await next, "timeout");
});


// Block asks: with the setting on, an askable
// block opens a dangerous card.
type Card = { id: string; summary: string; danger?: boolean };
type Harness = Awaited<ReturnType<typeof setup>>;

const skillWrite = (home: string) => ({
  tool: "Write",
  input: { file_path: join(home, "skills", "x", "SKILL.md"), content: "hello" },
  cwd: "E:\\projects\\x",
});
const putBlockAsks = (h: Harness, enabled: unknown, as?: Caller) =>
  h.api("/api/guard/block-asks", { method: "PUT", body: JSON.stringify({ enabled }), ...(as ? { as } : {}) });
const cardOf = async (h: Harness) => (await h.pending()) as Card;

test("block asks: the setting defaults off, reads, writes, and needs a boolean from owner", async (t) => {
  const h = await setup(t);
  const state = async () => (await (await h.api("/api/guard/block-asks")).json()) as { enabled: boolean };
  assert.deepEqual(await state(), { enabled: false });
  assert.equal((await putBlockAsks(h, "yes")).status, 400);
  assert.equal((await putBlockAsks(h, 1)).status, 400);
  assert.equal((await putBlockAsks(h, true, "ada")).status, 403);
  assert.equal((await h.api("/api/guard/block-asks", { method: "POST", body: "{}" })).status, 405);
  assert.deepEqual(await state(), { enabled: false });
  assert.deepEqual(await (await putBlockAsks(h, true)).json(), { enabled: true });
  assert.deepEqual(await state(), { enabled: true });
  assert.deepEqual(await (await putBlockAsks(h, false)).json(), { enabled: false });
  assert.deepEqual(await state(), { enabled: false });
});

test("block asks off: blocks still deny with no card", async (t) => {
  const h = await setup(t, 200);
  for (const call of [skillWrite(h.home), BLOCK]) {
    const got = (await (await h.check(call)).json()) as { decision: string; asked: boolean; reason: string };
    assert.deepEqual([got.decision, got.asked], ["deny", false]);
    assert.match(got.reason, /never runs/);
  }
  const g = (await (await h.api("/api/guard")).json()) as { pending: unknown[]; recent: { outcome: string }[] };
  assert.deepEqual(g.pending, []);
  assert.deepEqual(g.recent.map((e) => e.outcome), ["blocked", "blocked"]);
});

test("block asks on: an askable block opens a dangerous card; allow runs it, deny denies it", async (t) => {
  const h = await setup(t);
  await putBlockAsks(h, true);
  const call = skillWrite(h.home);

  const allowed = h.check(call);
  const card = await cardOf(h);
  assert.equal(card.danger, true);
  assert.match(card.summary, /SKILL\.md/);
  assert.equal((await h.decideCard(card.id, true)).status, 200);
  assert.deepEqual(await (await allowed).json(), { decision: "allow", asked: true });

  const denied = h.check(call);
  await h.decideCard((await cardOf(h)).id, false);
  const body = (await (await denied).json()) as { decision: string; reason: string };
  assert.equal(body.decision, "deny");
  assert.match(body.reason, /denied/);

  const g = (await (await h.api("/api/guard")).json()) as { recent: { outcome: string; danger?: boolean }[] };
  assert.deepEqual(g.recent.map((e) => [e.outcome, e.danger]), [["denied", true], ["allowed", true]]);
});

test("block asks on: a dangerous card that nobody answers denies, even with rule asks off", async (t) => {
  const h = await setup(t, 200);
  await h.api("/api/guard/rule-asks", { method: "PUT", body: JSON.stringify({ enabled: false }) });
  await putBlockAsks(h, true);
  const late = (await (await h.check(skillWrite(h.home))).json()) as { decision: string; asked: boolean; reason: string };
  assert.deepEqual([late.decision, late.asked], ["deny", true]);
  assert.match(late.reason, /nobody answered/);
  const g = (await (await h.api("/api/guard")).json()) as { recent: { outcome: string; danger?: boolean }[] };
  assert.deepEqual([g.recent[0]!.outcome, g.recent[0]!.danger], ["timeout", true]);
});

test("block asks on: a dangerous card with rule asks off still waits for owner", async (t) => {
  const h = await setup(t);
  await h.api("/api/guard/rule-asks", { method: "PUT", body: JSON.stringify({ enabled: false }) });
  await putBlockAsks(h, true);
  const run = h.check(skillWrite(h.home));
  const card = await cardOf(h);
  assert.equal(card.danger, true);
  await h.decideCard(card.id, true);
  assert.deepEqual(await (await run).json(), { decision: "allow", asked: true });
});

test("block asks on: every floor rule still denies with no card", async (t) => {
  const h = await setup(t);
  await putBlockAsks(h, true);
  const home = h.home;
  const floor: { tool: string; input: Record<string, unknown> }[] = [
    { tool: "Write", input: { file_path: join(home, "lounge.db"), content: "x" } },
    { tool: "Write", input: { file_path: join(home, "lounge.db-wal"), content: "x" } },
    { tool: "Write", input: { file_path: join(home, "config.json"), content: "{}" } },
    { tool: "Write", input: { file_path: join(home, "tokens.json"), content: "{}" } },
    { tool: "Write", input: { file_path: join(home, "secrets.json"), content: "{}" } },
    { tool: "Write", input: { file_path: join(home, "guard", "state.json"), content: "[]" } },
    { tool: "Write", input: { file_path: join(home, "plugins", "a", "index.js"), content: "x" } },
    { tool: "Write", input: { file_path: join(home, "skills", "settings.json"), content: "{}" } },
    { tool: "Bash", input: { command: "curl -X POST http://127.0.0.1:47621/api/guard/approvals/1" } },
    { tool: "PowerShell", input: { command: `Get-Content ${join(home, "tokens.json")}` } },
    { tool: "PowerShell", input: { command: `Remove-Item -Recurse -Force ${home}` } },
    { tool: "PowerShell", input: { command: `Move-Item ${home} E:\\old` } },
    { tool: "PowerShell", input: { command: `$home = 'x'; Get-Content ${join(home, "secrets.json")}` } },
    { tool: "Read", input: { file_path: join(home, "tokens.json") } },
    { tool: "Grep", input: { pattern: "sk-", path: home, glob: "tokens.json" } },
  ];
  const wrong: string[] = [];
  for (const call of floor) {
    const got = (await (await h.check({ ...call, cwd: "E:\\projects\\x" })).json()) as { decision: string; asked: boolean };
    if (got.decision !== "deny" || got.asked) wrong.push(`${call.tool} ${JSON.stringify(call.input)}`);
  }
  assert.deepEqual(wrong, []);
  const g = (await (await h.api("/api/guard")).json()) as { pending: unknown[] };
  assert.deepEqual(g.pending, []);
});

// A guard with block asks on.
function blockGuard(t: TestContext, extra: Partial<ConstructorParameters<typeof Guard>[0]> = {}, timeoutMs = 50) {
  const home = tempHome();
  t.after(() => home.cleanup());
  const approvals = new Approvals({ timeoutMs });
  const audit = new Audit(home.dir);
  const guard = new Guard({ home: home.dir, approvals, audit, blockAsks: () => true, ...extra });
  const action = guard.action("Write", { file_path: join(home.dir, "skills", "a.md"), content: "x" }, "E:\\projects\\x");
  return { home: home.dir, guard, approvals, audit, action };
}

test("block asks on: a plugin allow cannot lower an askable block, and a plugin block makes it a floor block", async (t) => {
  const low = blockGuard(t, { plugins: () => [{ plugin: "p", fn: () => ({ verdict: "allow" }) }] });
  const asked = await low.guard.check("ada", low.action);
  assert.deepEqual([asked.decision, asked.asked], ["deny", true]);
  assert.match(asked.reason ?? "", /nobody answered/);

  const hard = blockGuard(t, { plugins: () => [{ plugin: "q", fn: () => ({ verdict: "block", reason: "plugin says no" }) }] });
  const denied = await hard.guard.check("ada", hard.action);
  assert.deepEqual([denied.decision, denied.asked], ["deny", false]);
  assert.deepEqual(hard.approvals.pending(), []);
});

test("block asks: a setting that throws denies with no card", async (t) => {
  const { guard, action, approvals } = blockGuard(t, {
    blockAsks: () => {
      throw new Error("db closed");
    },
  });
  const got = await guard.check("ada", action);
  assert.deepEqual([got.decision, got.asked], ["deny", false]);
  assert.deepEqual(approvals.pending(), []);
});

test("block asks on: read-only mode denies an askable block with no card", async (t) => {
  const { guard, action, approvals } = blockGuard(t, { mode: () => "read-only" });
  const got = await guard.check("ada", action);
  assert.deepEqual([got.decision, got.asked], ["deny", false]);
  assert.match(got.reason ?? "", /read-only/);
  assert.deepEqual(approvals.pending(), []);
});

test("block asks on: the card and the audit entry carry danger, a normal card does not", async (t) => {
  const { guard, action, approvals, audit } = blockGuard(t, {}, 5_000);
  const run = guard.check("ada", action);
  for (let i = 0; i < 200 && approvals.pending().length === 0; i++) await new Promise((r) => setTimeout(r, 5));
  assert.equal(approvals.pending()[0]!.danger, true);
  approvals.decide(approvals.pending()[0]!.id, true);
  assert.equal((await run).decision, "allow");
  assert.equal(audit.recent()[0]!.danger, true);

  const plain = guard.check("ada", guard.action(ASK.tool, ASK.input, ASK.cwd));
  for (let i = 0; i < 200 && approvals.pending().length === 0; i++) await new Promise((r) => setTimeout(r, 5));
  assert.equal("danger" in approvals.pending()[0]!, false);
  approvals.decide(approvals.pending()[0]!.id, false);
  await plain;
  assert.equal(audit.recent()[0]!.danger, undefined);
});

test("block asks on: a dangerous approval covers one call, and the same call asks again", async (t) => {
  const h = await setup(t);
  await putBlockAsks(h, true);
  const call = skillWrite(h.home);

  const first = h.check(call);
  const one = await cardOf(h);
  await h.decideCard(one.id, true);
  assert.equal(((await (await first).json()) as { decision: string }).decision, "allow");

  const second = h.check(call);
  const two = await cardOf(h);
  assert.notEqual(two.id, one.id);
  await h.decideCard(two.id, false);
  assert.equal(((await (await second).json()) as { decision: string }).decision, "deny");
});

