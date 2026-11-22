import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import type { Approvals, ApprovalInput } from "../src/guard/approvals.ts";
import { Audit, type AuditEntry } from "../src/guard/audit.ts";
import { Guard, type PluginGuard } from "../src/guard/guard.ts";
import type { GuardMode } from "../src/guard/guardMode.ts";
import type { ClassifyRequest, ToolMode } from "../src/guard/modes.ts";
import { tempHome } from "./helpers.ts";

const CWD = "E:\\projects\\x";
type Call = readonly [string, Record<string, unknown>];

const SHELL_ALLOW: Call = ["Bash", { command: "mkdir out" }];
const SHELL_READ: Call = ["Bash", { command: "git status" }];
const SHELL_ASK: Call = ["PowerShell", { command: "Remove-Item -Recurse E:\\projects\\x\\src" }];
const SHELL_BLOCK: Call = ["PowerShell", { command: "$home = 'x'; Remove-Item -Recurse -Force $home" }];
const WRITE_ASK: Call = ["Write", { file_path: "C:\\Windows\\System32\\x.txt", content: "hi" }];
const WRITE_ALLOW: Call = ["Write", { file_path: "E:\\projects\\x\\a.txt", content: "hi" }];
const READ_ALLOW: Call = ["Read", { file_path: "E:\\projects\\x\\a.txt" }];

class FakeApprovals {
  cards: ApprovalInput[] = [];
  answer: boolean | "timeout" = true;
  async request(input: ApprovalInput): Promise<boolean | "timeout"> {
    this.cards.push(input);
    return this.answer;
  }
}

type Runner = (agent: string, request: ClassifyRequest, signal: AbortSignal) => Promise<string> | undefined;

interface RigOptions {
  gm?: GuardMode | (() => GuardMode);
  tool?: ToolMode;
  judge?: Runner | "none";
  classify?: Runner;
  policy?: string;
  plugins?: PluginGuard[];
  ruleAsks?: boolean;
  classifyMs?: number;
}

function rig(t: TestContext, opts: RigOptions = {}) {
  const home = tempHome();
  t.after(() => home.cleanup());
  const approvals = new FakeApprovals();
  const audit = new Audit(home.dir);
  const judged: ClassifyRequest[] = [];
  const classified: ClassifyRequest[] = [];
  const custom = typeof opts.judge === "function" ? opts.judge : undefined;
  const judge: Runner | undefined =
    opts.judge === "none"
      ? undefined
      : (agent, request, signal) => {
          judged.push(request);
          return (custom ?? (() => Promise.resolve("SAFE")))(agent, request, signal);
        };
  const classify: Runner = (agent, request, signal) => {
    classified.push(request);
    return (opts.classify ?? (() => Promise.resolve("SAFE")))(agent, request, signal);
  };
  const gm = opts.gm;
  const guard = new Guard({
    home: home.dir,
    approvals: approvals as unknown as Approvals,
    audit,
    mode: () => opts.tool ?? "full",
    classify,
    ...(gm !== undefined ? { guardMode: typeof gm === "function" ? gm : () => gm } : {}),
    ...(judge ? { judge } : {}),
    ...(opts.policy !== undefined ? { judgePolicy: () => opts.policy! } : {}),
    ...(opts.plugins ? { plugins: () => opts.plugins! } : {}),
    ...(opts.ruleAsks !== undefined ? { ruleAsks: () => opts.ruleAsks! } : {}),
    ...(opts.classifyMs !== undefined ? { classifyMs: opts.classifyMs } : {}),
  });
  return { approvals, audit, guard, judged, classified };
}

type Rig = ReturnType<typeof rig>;

async function run(r: Rig, call: Call, signal?: AbortSignal) {
  const before = r.audit.recent().length;
  const result = await r.guard.check("nana", r.guard.action(call[0], call[1], CWD), signal);
  const entries = r.audit.recent().slice(0, r.audit.recent().length - before) as AuditEntry[];
  return { result, entries };
}

const summary = (x: Awaited<ReturnType<typeof run>>) => ({
  decision: x.result.decision,
  asked: x.result.asked,
  rows: x.entries.map((e) => [e.verdict, e.outcome, e.source]),
});

test("c3_1: normal mode keeps every decision of the guard before modes",async (t) => {
  const calls = [SHELL_ALLOW, SHELL_READ, SHELL_ASK, SHELL_BLOCK, WRITE_ASK, WRITE_ALLOW, READ_ALLOW];
  for (const tool of ["read-only", "ask", "auto", "full"] as const) {
    for (const call of calls) {
      const today = rig(t, { tool });
      const normal = rig(t, { tool, gm: "normal", judge: () => Promise.resolve("SAFE") });
      assert.deepEqual(summary(await run(normal, call)), summary(await run(today, call)), `${tool} ${call[0]}`);
      assert.equal(normal.approvals.cards.length, today.approvals.cards.length, `${tool} ${call[0]}`);
      assert.equal(normal.judged.length, 0);
    }
  }
});

test("c3_1: auto allows a rule ask with no card when the judge says SAFE", async (t) => {
  const r = rig(t, { gm: "auto", tool: "auto", policy: "SAFE: ls" });
  const { result, entries } = await run(r, SHELL_ASK);
  assert.deepEqual([result.decision, result.asked], ["allow", false]);
  assert.equal(r.approvals.cards.length, 0);
  assert.deepEqual(entries.map((e) => [e.verdict, e.outcome, e.source]), [["ask", "auto-allowed", "judge"]]);
  assert.equal(r.classified.length, 0, "a judge SAFE skips the tool mode classifier");
  assert.equal(r.judged.length, 1);
  assert.match(r.judged[0]!.user, /Rule reason: .*recursive delete/);
  assert.doesNotMatch(r.judged[0]!.system, /Rule reason/);
  assert.ok(r.judged[0]!.system.includes("Owner policy:\nSAFE: ls"));
});

test("c3_1: auto opens a card with the judge reason when the judge says UNSAFE", async (t) => {
  const r = rig(t, { gm: "auto", judge: () => Promise.resolve("UNSAFE: it deletes the source folder") });
  const { result, entries } = await run(r, SHELL_ASK);
  assert.deepEqual([result.decision, result.asked], ["allow", true]);
  assert.equal(r.approvals.cards.length, 1);
  assert.match(r.approvals.cards[0]!.reason, /^auto guard: it deletes the source folder/);
  assert.match(r.approvals.cards[0]!.reason, /recursive delete/);
  assert.deepEqual(entries.map((e) => [e.verdict, e.outcome, e.source]), [["ask", "allowed", "judge"]]);
  r.approvals.answer = false;
  assert.equal((await run(r, SHELL_ASK)).result.decision, "deny");
});

test("c3_1: auto judges a plugin ask and a non-mutating ask in the same way", async (t) => {
  const plugin: PluginGuard = { plugin: "p", fn: () => ({ verdict: "ask", reason: "plugin wants a look" }) };
  const r = rig(t, { gm: "auto", plugins: [plugin] });
  const { result, entries } = await run(r, READ_ALLOW);
  assert.deepEqual([result.decision, result.asked], ["allow", false]);
  assert.deepEqual(entries.map((e) => [e.verdict, e.outcome, e.source]), [["ask", "auto-allowed", "judge"]]);
  assert.match(r.judged[0]!.user, /Rule reason: plugin wants a look/);
  assert.ok(!r.judged[0]!.system.includes("plugin wants a look"));
});

test("c3_1: auto leaves an allowed call to the agent tool mode", async (t) => {
  const full = rig(t, { gm: "auto", tool: "full" });
  assert.equal((await run(full, SHELL_ALLOW)).result.asked, false);
  const ask = rig(t, { gm: "auto", tool: "ask" });
  assert.equal((await run(ask, SHELL_ALLOW)).result.asked, true);
  assert.equal(ask.approvals.cards.length, 1);
  const auto = rig(t, { gm: "auto", tool: "auto" });
  const { entries } = await run(auto, SHELL_ALLOW);
  assert.deepEqual(entries.map((e) => [e.outcome, e.source]), [["auto-allowed", "classifier"]]);
  for (const r of [full, ask, auto]) assert.equal(r.judged.length, 0);
});

test("c3_1: bypass allows a rule ask and a plugin ask with no card and logs it", async (t) => {
  const plugin: PluginGuard = { plugin: "p", fn: () => ({ verdict: "ask", reason: "plugin wants a look" }) };
  const r = rig(t, { gm: "bypass", tool: "ask", plugins: [plugin] });
  for (const call of [SHELL_ASK, WRITE_ASK, READ_ALLOW]) {
    const { result, entries } = await run(r, call);
    assert.deepEqual([result.decision, result.asked], ["allow", false], call[0]);
    assert.deepEqual(entries.map((e) => [e.outcome, e.source]), [["bypass-allowed", "guard-mode"]], call[0]);
  }
  assert.equal(r.approvals.cards.length, 0);
  assert.equal(r.judged.length + r.classified.length, 0);
});

test("c3_1: bypass skips the tool mode card and the classifier and logs it", async (t) => {
  for (const tool of ["ask", "auto"] as const) {
    const r = rig(t, { gm: "bypass", tool });
    const { result, entries } = await run(r, SHELL_ALLOW);
    assert.deepEqual([result.decision, result.asked], ["allow", false], tool);
    assert.deepEqual(entries.map((e) => [e.verdict, e.outcome, e.source]), [["allow", "bypass-allowed", "guard-mode"]], tool);
    assert.equal(r.approvals.cards.length + r.classified.length + r.judged.length, 0, tool);
  }
});

test("c3_1: bypass still denies a change for a read-only agent", async (t) => {
  const r = rig(t, { gm: "bypass", tool: "read-only" });
  for (const call of [SHELL_ALLOW, SHELL_ASK, WRITE_ALLOW]) {
    const { result, entries } = await run(r, call);
    assert.deepEqual([result.decision, result.asked], ["deny", false], call[0]);
    assert.deepEqual(entries.map((e) => [e.outcome, e.source]), [["denied", "mode"]], call[0]);
  }
  assert.equal((await run(r, SHELL_READ)).result.decision, "allow");
});

test("c3_1: bypass adds no audit row for a call that needed no check", async (t) => {
  for (const tool of ["ask", "auto", "full"] as const) {
    const r = rig(t, { gm: "bypass", tool });
    for (const call of [SHELL_READ, READ_ALLOW]) {
      const { result, entries } = await run(r, call);
      assert.deepEqual([result.decision, result.asked], ["allow", false], `${tool} ${call[0]}`);
      assert.equal(entries.length, 0, `${tool} ${call[0]}`);
    }
  }
  const full = rig(t, { gm: "bypass", tool: "full" });
  assert.equal((await run(full, SHELL_ALLOW)).entries.length, 0);
});

test("c3_1: a rule ask with rule asks off stays allowed in every guard mode and is never judged", async (t) => {
  for (const gm of ["normal", "auto", "bypass"] as const) {
    const r = rig(t, { gm, tool: "full", ruleAsks: false });
    const { result } = await run(r, SHELL_ASK);
    assert.deepEqual([result.decision, result.asked], ["allow", false], gm);
    assert.equal(r.judged.length + r.approvals.cards.length, 0, gm);
  }
});

test("c3_2: a block is never a silent allow, and the guard mode is not read", async (t) => {
  for (const gm of ["normal", "auto", "bypass"] as const) {
    let reads = 0;
    const r = rig(t, { gm: () => (reads++, gm), tool: "full" });
    const { result, entries } = await run(r, SHELL_BLOCK);
    assert.deepEqual([result.decision, result.asked], ["deny", false], gm);
    assert.deepEqual(entries.map((e) => [e.verdict, e.outcome]), [["block", "blocked"]], gm);
    assert.equal(reads, 0, gm);
    assert.equal(r.judged.length + r.classified.length + r.approvals.cards.length, 0, gm);
  }
});

test("c3_2: a plugin block under bypass and auto still denies", async (t) => {
  const plugin: PluginGuard = { plugin: "p", fn: () => ({ verdict: "block", reason: "plugin says no" }) };
  for (const gm of ["auto", "bypass"] as const) {
    const r = rig(t, { gm, plugins: [plugin] });
    const { result } = await run(r, SHELL_ALLOW);
    assert.equal(result.decision, "deny", gm);
    assert.equal(r.approvals.cards.length, 0, gm);
  }
});

test("c3_3: a judge error opens a card", async (t) => {
  const r = rig(t, { gm: "auto", judge: () => Promise.reject(new Error("claude was not found")) });
  const { result, entries } = await run(r, SHELL_ASK);
  assert.deepEqual([result.decision, result.asked], ["allow", true]);
  assert.match(r.approvals.cards[0]!.reason, /^auto guard: the check failed: claude was not found/);
  assert.deepEqual(entries.map((e) => [e.outcome, e.source]), [["allowed", "judge"]]);
});

test("c3_3: a judge timeout opens a card", async (t) => {
  const r = rig(t, { gm: "auto", classifyMs: 20, judge: () => new Promise<string>(() => {}) });
  const { result } = await run(r, SHELL_ASK);
  assert.equal(result.asked, true);
  assert.match(r.approvals.cards[0]!.reason, /timed out/);
});

test("c3_3: an unclear judge reply opens a card", async (t) => {
  for (const text of ["", "maybe", "SAFE\nUNSAFE: not sure", "safe but wait", "SAFE: ok", "SAFE - ok", "**SAFE**", "safe"]) {
    const r = rig(t, { gm: "auto", judge: () => Promise.resolve(text) });
    const { result } = await run(r, SHELL_ASK);
    assert.equal(result.asked, true, JSON.stringify(text));
    assert.equal(r.approvals.cards.length, 1, JSON.stringify(text));
  }
});

test("c3_3: no judge for the runtime opens a card", async (t) => {
  const r = rig(t, { gm: "auto", judge: "none" });
  const { result } = await run(r, SHELL_ASK);
  assert.equal(result.asked, true);
  assert.match(r.approvals.cards[0]!.reason, /^auto guard: no judge for this runtime/);
});

test("c3_3: a cut command opens a card and is not judged", async (t) => {
  const r = rig(t, { gm: "auto" });
  const long: Call = ["PowerShell", { command: `Remove-Item -Recurse E:\\projects\\x\\src # ${"a".repeat(32_100)}` }];
  const { result } = await run(r, long);
  assert.equal(result.asked, true);
  assert.equal(r.judged.length, 0);
  assert.match(r.approvals.cards[0]!.reason, /^auto guard: .*too long/);
});

test("c3_3: an aborted turn denies and opens no card", async (t) => {
  const turn = new AbortController();
  let started: () => void = () => {};
  const reached = new Promise<void>((resolve) => (started = resolve));
  let release: (text: string) => void = () => {};
  const r = rig(t, {
    gm: "auto",
    judge: () => {
      started();
      return new Promise<string>((resolve) => (release = resolve));
    },
  });
  const pending = run(r, SHELL_ASK, turn.signal);
  await reached;
  turn.abort();
  const { result, entries } = await pending;
  release("SAFE");
  assert.deepEqual([result.decision, result.asked], ["deny", false]);
  assert.equal(r.approvals.cards.length, 0);
  assert.equal(entries.some((e) => e.outcome === "auto-allowed"), false);
});

test("c3_1: a guard mode lookup that throws gives normal", async (t) => {
  const r = rig(t, {
    gm: () => {
      throw new Error("no store");
    },
    tool: "full",
  });
  const { result } = await run(r, SHELL_ASK);
  assert.deepEqual([result.decision, result.asked], ["allow", true]);
  assert.equal(r.approvals.cards.length, 1);
  assert.equal(r.judged.length, 0);
});
