import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Approvals, ApprovalInput } from "../src/guard/approvals.ts";
import { Audit } from "../src/guard/audit.ts";
import { classify, classifyBudget, MODELS_KEY, readModels, resolveClaude, type ClassifierOptions } from "../src/guard/classifier.ts";
import { Guard } from "../src/guard/guard.ts";
import { CLASSIFY_MS, classifyRequest, parseClassifier, type ClassifyRequest, type ToolMode } from "../src/guard/modes.ts";
import { writeSetting } from "../src/db/settings.ts";
import { startCore } from "../src/api/http.ts";
import { replyAdapter } from "../src/adapters/stub.ts";
import type { RuntimeKind } from "../src/roster/types.ts";
import { tempHome } from "./helpers.ts";

// The fake claude reads its per-model behavior from a plan file and logs each call.
const FAKE = `
const fs = require("node:fs");
const plan = JSON.parse(fs.readFileSync(process.env.FAKE_PLAN, "utf8"));
const argv = process.argv.slice(2);
const model = argv[argv.indexOf("--model") + 1];
let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => (stdin += d));
process.stdin.on("end", () => {
  fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ model, argv, stdin, mds: process.env.CLAUDE_CODE_DISABLE_CLAUDE_MDS }) + "\\n");
  const b = plan[model] ?? { result: "SAFE" };
  if (b.hang) return void setTimeout(() => {}, 60000);
  if (b.exit) process.exit(b.exit);
  if (b.raw !== undefined) return void process.stdout.write(b.raw);
  process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: !!b.isError, result: b.result }));
});
`;

type Behavior = { result?: string; isError?: boolean; exit?: number; raw?: string; hang?: boolean };
type Call = { model: string; argv: string[]; stdin: string; mds: string };

const CWD = "E:\\projects\\x";

function bench(t: TestContext, plan: Record<string, Behavior>, models: string[], extra: Partial<ClassifierOptions> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "classifier-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));
  const script = join(dir, "fake-claude.cjs");
  const log = join(dir, "calls.log");
  writeFileSync(script, FAKE);
  writeFileSync(join(dir, "plan.json"), JSON.stringify(plan));
  const opts: ClassifierOptions = {
    models: () => models,
    claude: { file: process.execPath, args: [script] },
    env: { ...process.env, FAKE_PLAN: join(dir, "plan.json"), FAKE_LOG: log },
    timeoutMs: 5_000,
    ...extra,
  };
  const calls = (): Call[] =>
    existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Call) : [];
  return { dir, opts, calls, log };
}

const redact = (text: string) => text;
function req(command = "mkdir out", cwd = CWD, nonce = "n1"): ClassifyRequest {
  return classifyRequest("nana", { tool: "Bash", kind: "shell", command, cwd }, redact, nonce);
}
const signal = () => new AbortController().signal;

test("c8_3: an isolated claude -p call answers SAFE, with the tested flags and the request on stdin", async (t) => {
  const b = bench(t, { m1: { result: "SAFE" } }, ["m1"]);
  const request = req();
  assert.equal(await classify(request, signal(), b.opts), "SAFE");
  const [call] = b.calls();
  assert.equal(b.calls().length, 1);
  const a = call!.argv;
  assert.equal(a[a.indexOf("--system-prompt") + 1], request.system);
  assert.equal(a[a.indexOf("--output-format") + 1], "json");
  assert.equal(a[a.indexOf("--setting-sources") + 1], "project,local");
  for (const flag of ["-p", "--strict-mcp-config", "--disable-slash-commands"]) assert.ok(a.includes(flag), flag);
  assert.equal(a.includes("--bare"), false);
  assert.equal(call!.stdin, request.user);
  assert.equal(call!.mds, "1");
});

test("sc: any text but an exact SAFE is not a safe verdict", async (t) => {
  const replies = ["ASK", "UNSAFE: deletes a folder", "SAFE: but check it", "I think this is SAFE", "", "safe to run"];
  for (const result of replies) {
    const b = bench(t, { m1: { result } }, ["m1"]);
    const text = await classify(req(), signal(), b.opts);
    assert.equal(parseClassifier(text).safe, false, JSON.stringify(result));
  }
  const exact = bench(t, { m1: { result: "SAFE\n" } }, ["m1"]);
  assert.equal(await classify(req(), signal(), exact.opts), "SAFE");
});

test("c8_2: a model that exits non-zero, errors, returns bad JSON, or times out falls to the next model", async (t) => {
  const plan: Record<string, Behavior> = {
    exit: { exit: 1 },
    err: { isError: true, result: "There is an issue with the selected model" },
    junk: { raw: "not json" },
    nostr: { raw: JSON.stringify({ is_error: false }) },
    slow: { hang: true },
    ok: { result: "SAFE" },
  };
  const b = bench(t, plan, ["exit", "err", "junk", "nostr", "slow", "ok"], { timeoutMs: 700 });
  assert.equal(await classify(req(), signal(), b.opts), "SAFE");
  assert.deepEqual(b.calls().map((c) => c.model), ["exit", "err", "junk", "nostr", "slow", "ok"]);
});

test("c8_2: the first model that answers ends the list, even when its answer is not SAFE", async (t) => {
  const b = bench(t, { a: { result: "UNSAFE: no" }, b: { result: "SAFE" } }, ["a", "b"]);
  assert.equal(parseClassifier(await classify(req(), signal(), b.opts)).safe, false);
  assert.deepEqual(b.calls().map((c) => c.model), ["a"]);
});

test("c8_2: when every model fails or times out, classify rejects and never answers SAFE", async (t) => {
  const b = bench(t, { a: { exit: 2 }, b: { hang: true } }, ["a", "b"], { timeoutMs: 500 });
  await assert.rejects(classify(req(), signal(), b.opts), /a: exit 2.*b: timed out/);
  const none = bench(t, {}, []);
  await assert.rejects(classify(req(), signal(), none.opts), /no classifier model/);
  assert.equal(none.calls().length, 0);
});

test("c8_2: an abort stops the list and kills the running model", async (t) => {
  const b = bench(t, { a: { hang: true }, b: { result: "SAFE" } }, ["a", "b"]);
  const ac = new AbortController();
  setTimeout(() => ac.abort(new Error("turn ended")), 400);
  await assert.rejects(classify(req(), ac.signal, b.opts), /turn ended/);
  assert.deepEqual(b.calls().map((c) => c.model), ["a"]);
});

test("a cached SAFE skips the call; ASK and errors are not cached; cwd and command split the key", async (t) => {
  const cache = new Set<string>();
  const b = bench(t, { m1: { result: "SAFE" } }, ["m1"], { cache });
  await classify(req("mkdir out", CWD, "n1"), signal(), b.opts);
  await classify(req("mkdir out", CWD, "n2"), signal(), b.opts);
  await classify(req("mkdir out\r\n", CWD, "n3"), signal(), b.opts);
  assert.equal(b.calls().length, 1);
  await classify(req("mkdir out", "E:\\projects\\y", "n4"), signal(), b.opts);
  await classify(req("mkdir other", CWD, "n5"), signal(), b.opts);
  assert.equal(b.calls().length, 3);

  const ask = bench(t, { m1: { result: "ASK" } }, ["m1"], { cache: new Set() });
  await classify(req(), signal(), ask.opts);
  await classify(req(), signal(), ask.opts);
  assert.equal(ask.calls().length, 2);

  const bad = bench(t, { m1: { exit: 1 } }, ["m1"], { cache: new Set() });
  await assert.rejects(classify(req(), signal(), bad.opts));
  await assert.rejects(classify(req(), signal(), bad.opts));
  assert.equal(bad.calls().length, 2);
});

test("the SAFE cache stays under its cap", async (t) => {
  const cache = new Set<string>();
  const b = bench(t, { m1: { result: "SAFE" } }, ["m1"], { cache, cacheMax: 2 });
  for (const c of ["a", "b", "c"]) await classify(req(c), signal(), b.opts);
  assert.equal(cache.size, 2);
});

test("the models come from the classifier.models setting, in order", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  assert.deepEqual(readModels(db), []);
  writeSetting(db, MODELS_KEY, " haiku , sonnet,,opus ");
  assert.deepEqual(readModels(db), ["haiku", "sonnet", "opus"]);
  assert.equal(MODELS_KEY, "classifier.models");
});

test("resolveClaude prefers claude.exe, then reads the npm shim beside claude.cmd, and never needs a shell", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "classifier-path-"));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));
  const env = { PATH: dir };
  assert.throws(() => resolveClaude(env), /not found/);
  if (process.platform !== "win32") {
    writeFileSync(join(dir, "claude"), "");
    assert.deepEqual(resolveClaude(env), { file: join(dir, "claude"), args: [] });
    return;
  }
  writeFileSync(join(dir, "claude.cmd"), "");
  assert.throws(() => resolveClaude(env), /shell/);
  const pkg = join(dir, "node_modules", "@anthropic-ai", "claude-code");
  mkdirSync(pkg, { recursive: true });
  writeFileSync(join(pkg, "cli.js"), "");
  assert.deepEqual(resolveClaude(env), { file: process.execPath, args: [join(pkg, "cli.js")] });
  mkdirSync(join(pkg, "bin"));
  writeFileSync(join(pkg, "bin", "claude.exe"), "");
  assert.deepEqual(resolveClaude(env), { file: join(pkg, "bin", "claude.exe"), args: [] });
  writeFileSync(join(dir, "claude.exe"), "");
  assert.deepEqual(resolveClaude(env), { file: join(dir, "claude.exe"), args: [] });
  assert.deepEqual(resolveClaude({ PATH: `${join(dir, "none")}${delimiter}${dir}` }), { file: join(dir, "claude.exe"), args: [] });
});

// The guard drives the classifier, as in a turn.
class FakeApprovals {
  cards: ApprovalInput[] = [];
  async request(input: ApprovalInput): Promise<boolean | "timeout"> {
    this.cards.push(input);
    return false;
  }
}

function guardRig(t: TestContext, b: ReturnType<typeof bench>, mode: ToolMode, classifyMs?: number | (() => number)) {
  const home = tempHome();
  t.after(() => home.cleanup());
  const approvals = new FakeApprovals();
  const guard = new Guard({
    home: home.dir,
    approvals: approvals as unknown as Approvals,
    audit: new Audit(home.dir),
    mode: () => mode,
    ...(classifyMs === undefined ? {} : { classifyMs }),
    classify: (_agent, request, sig) => classify(request, sig, b.opts),
  });
  return { approvals, check: (tool: string, input: Record<string, unknown>) => guard.check("nana", guard.action(tool, input, CWD)) };
}

const BLOCK = ["PowerShell", { command: "$home = 'x'; Remove-Item -Recurse -Force $home" }] as const;
const MUTATE = ["Bash", { command: "mkdir out" }] as const;

test("c8_1 / sc14: a block stays a deny in every mode and the classifier never runs", async (t) => {
  for (const mode of ["read-only", "ask", "auto", "full"] as const) {
    const b = bench(t, { m1: { result: "SAFE" } }, ["m1"]);
    const g = guardRig(t, b, mode);
    const result = await g.check(...BLOCK);
    assert.equal(result.decision, "deny", mode);
    assert.equal(g.approvals.cards.length, 0, mode);
    assert.equal(b.calls().length, 0, mode);
  }
});

test("sc: in auto mode a SAFE answer allows with no card, and a mode other than auto never spawns", async (t) => {
  const b = bench(t, { m1: { result: "SAFE" } }, ["m1"]);
  const auto = guardRig(t, b, "auto");
  assert.deepEqual(await auto.check(...MUTATE), { decision: "allow", asked: false });
  assert.equal(b.calls().length, 1);
  for (const mode of ["ask", "full"] as const) {
    const other = bench(t, { m1: { result: "SAFE" } }, ["m1"]);
    await guardRig(t, other, mode).check(...MUTATE);
    assert.equal(other.calls().length, 0, mode);
  }
});

test("sc: in auto mode other text opens a card, and the owner's no is a deny", async (t) => {
  const b = bench(t, { m1: { result: "UNSAFE: writes outside the folder" } }, ["m1"]);
  const g = guardRig(t, b, "auto");
  const result = await g.check(...MUTATE);
  assert.equal(g.approvals.cards.length, 1);
  assert.match(g.approvals.cards[0]!.reason, /writes outside the folder/);
  assert.deepEqual([result.decision, result.asked], ["deny", true]);
});

test("c8_3: a model that is not available falls to the next, and the next one allows", async (t) => {
  const b = bench(t, { gone: { isError: true, result: "There is an issue with the selected model" }, m2: { result: "SAFE" } }, ["gone", "m2"]);
  const g = guardRig(t, b, "auto");
  assert.deepEqual(await g.check(...MUTATE), { decision: "allow", asked: false });
  assert.deepEqual(b.calls().map((c) => c.model), ["gone", "m2"]);
});

test("sc15: when all models time out, an approval card opens and nothing is allowed", async (t) => {
  const b = bench(t, { a: { hang: true }, b: { hang: true } }, ["a", "b"], { timeoutMs: 400 });
  const g = guardRig(t, b, "auto");
  const result = await g.check(...MUTATE);
  assert.equal(g.approvals.cards.length, 1);
  assert.match(g.approvals.cards[0]!.reason, /^auto mode: the check failed: .*timed out/);
  assert.deepEqual([result.decision, result.asked], ["deny", true]);
});

test("the guard limit is the per-model limit times the model count, and an empty list still gets one", () => {
  assert.equal(classifyBudget(3), 3 * CLASSIFY_MS);
  assert.equal(classifyBudget(2, 500), 1000);
  assert.equal(classifyBudget(0), CLASSIFY_MS);
});

test("c8_2: a first model that times out still reaches the second within the guard's total limit", async (t) => {
  const b = bench(t, { slow: { hang: true }, m2: { result: "SAFE" } }, ["slow", "m2"], { timeoutMs: 600 });
  const budget = () => classifyBudget(b.opts.models().length, 600);
  const g = guardRig(t, b, "auto", budget);
  assert.deepEqual(await g.check(...MUTATE), { decision: "allow", asked: false });
  assert.deepEqual(b.calls().map((c) => c.model), ["slow", "m2"]);
  // With one flat limit of the same size, the second model never runs.
  const flat = bench(t, { slow: { hang: true }, m2: { result: "SAFE" } }, ["slow", "m2"], { timeoutMs: 600 });
  const f = guardRig(t, flat, "auto", 600);
  assert.equal((await f.check(...MUTATE)).asked, true);
});

test("c8_1: a rule ask opens a card with no spawn, and a guard that reads its limit as a function still works", async (t) => {
  const b = bench(t, { m1: { result: "SAFE" } }, ["m1"]);
  const g = guardRig(t, b, "auto", () => CLASSIFY_MS);
  await g.check("PowerShell", { command: "Remove-Item -Recurse E:\\projects\\x\\src" });
  assert.equal(g.approvals.cards.length, 1);
  assert.equal(b.calls().length, 0);
});

test("the core routes an auto-mode call to the classifier, and an empty model list opens a card", async (t) => {
  const home = tempHome();
  const kind: RuntimeKind = {
    id: "claude-code",
    label: "Claude Code",
    efforts: () => ["low"],
    models: () => ["opus"],
    create: () => replyAdapter("claude-code", ""),
    toolModes: true,
  };
  const core = await startCore({ home: home.dir, port: 0, schedule: false, approvalMs: 10_000, runtimes: [kind] });
  t.after(async () => {
    await core.close();
    home.cleanup();
  });
  const tokens = JSON.parse(readFileSync(join(home.dir, "tokens.json"), "utf8")) as Record<string, string>;
  const api = (path: string, init: RequestInit & { as?: string } = {}) => {
    const { as = "owner", ...rest } = init;
    return fetch(core.url + path, { ...rest, headers: { "content-type": "application/json", authorization: `Bearer ${tokens[as]}` } });
  };
  const moved = await api("/api/agents/ada", { method: "PATCH", body: JSON.stringify({ runtime: "claude-code", toolMode: "auto" }) });
  assert.equal(moved.status, 200);
  const asked = api("/guard/check", { method: "POST", as: "ada", body: JSON.stringify({ tool: "Bash", input: { command: "mkdir out" }, cwd: CWD }) });
  let card: { id: string; reason: string } | undefined;
  for (let i = 0; i < 300 && card === undefined; i++) {
    const g = (await (await api("/api/guard")).json()) as { pending: { id: string; reason: string }[] };
    card = g.pending[0];
    if (card === undefined) await new Promise((r) => setTimeout(r, 10));
  }
  assert.ok(card, "the empty model list opens a card");
  assert.match(card.reason, /no classifier model is set/);
  await api(`/api/guard/approvals/${card.id}`, { method: "POST", body: JSON.stringify({ allow: false }) });
  assert.equal(((await (await asked).json()) as { decision: string }).decision, "deny");
});
