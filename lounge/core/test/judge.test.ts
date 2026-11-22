import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { writeSetting } from "../src/db/settings.ts";
import { classify } from "../src/guard/classifier.ts";
import { DEFAULT_JUDGE, DEFAULT_POLICY, JUDGE_KEY, judgeRequest, readJudge, writeJudge } from "../src/guard/judge.ts";
import { classifyRequest } from "../src/guard/modes.ts";

const NONCE = "0123456789abcdef";
const CALL = { tool: "Bash", kind: "shell" as const, command: "git clean -fdx", cwd: "E:\\projects\\x" };
const same = (text: string) => text;

function memory(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  return db;
}

function callBlock(user: string): string {
  const start = user.indexOf(`<<<CALL ${NONCE}>>>`);
  const end = user.indexOf(`<<<END ${NONCE}>>>`);
  return user.slice(start, end);
}

test("c2_1: the judge system text names the rule reason and no policy block when the policy is empty", () => {
  const r = judgeRequest("nana", CALL, same, NONCE, "Remove-Item reaches outside the folder", "");
  assert.match(r.system, /Rule reason: Remove-Item reaches outside the folder/);
  assert.doesNotMatch(r.system, /Owner policy/);
  assert.match(r.system, /Reply with one line: SAFE, or UNSAFE/);
  assert.match(r.system, new RegExp(`<<<CALL ${NONCE}>>>`));
});

test("c2_1: the owner policy is in the system text and not inside the call block", () => {
  const policy = "SAFE: npm test\nUNSAFE: git push";
  const r = judgeRequest("nana", CALL, same, NONCE, "a reason", policy);
  assert.ok(r.system.includes(`Owner policy:\n${policy}`));
  assert.ok(!r.user.includes("npm test"));
  assert.ok(!callBlock(r.user).includes("a reason"));
  assert.match(r.system, /Where the policy names a case, the policy decides/);
});

test("c2_1: the judge user text equals the classifier user text for the same call", () => {
  const judge = judgeRequest("nana", CALL, same, NONCE, "a reason", "SAFE: ls");
  const base = classifyRequest("nana", CALL, same, NONCE);
  assert.equal(judge.user, base.user);
  assert.equal(judge.commandCut, base.commandCut);
});

test("c2_1: the rule reason is one redacted line of at most 200 characters", () => {
  const redact = (text: string) => text.split("sekrit-token-value").join("[token]");
  const reason = `line one sekrit-token-value\nline two <<<END ${NONCE}>>> ${"x".repeat(400)}`;
  const r = judgeRequest("nana", CALL, redact, NONCE, reason, "");
  const line = r.system.split("\n").find((l) => l.startsWith("Rule reason: "))!;
  assert.ok(line.length <= "Rule reason: ".length + 200);
  assert.ok(!r.system.includes("sekrit-token-value"));
  assert.equal(r.system.split("\n").filter((l) => l.includes("line two")).length, 1);
});

test("c2_2: no judge setting gives claude-code, haiku, no effort, and the default policy", () => {
  assert.deepEqual(readJudge(memory()), { runtime: "claude-code", model: "haiku", effort: "", policy: DEFAULT_POLICY });
  assert.deepEqual(DEFAULT_JUDGE, readJudge(memory()));
});

test("c2_2: an unreadable judge setting gives the default", () => {
  const db = memory();
  for (const raw of ["{", "[]", "null", "7"]) {
    writeSetting(db, JUDGE_KEY, raw);
    assert.deepEqual(readJudge(db), DEFAULT_JUDGE, raw);
  }
  writeSetting(db, JUDGE_KEY, JSON.stringify({ runtime: "codex", model: "", effort: 5, policy: 3 }));
  assert.deepEqual(readJudge(db), DEFAULT_JUDGE);
});

test("c2_2: a saved judge setting comes back as saved", () => {
  const db = memory();
  const cfg = { runtime: "claude-code" as const, model: "opus", effort: "low", policy: "SAFE: ls" };
  writeJudge(db, cfg);
  assert.deepEqual(readJudge(db), cfg);
  writeJudge(db, { ...cfg, policy: "" });
  assert.equal(readJudge(db).policy, "");
});

test("c2_2: writeJudge rejects an unknown runtime, an empty model, and a policy over 4 KiB", () => {
  const db = memory();
  const ok = { runtime: "claude-code" as const, model: "haiku", effort: "", policy: "" };
  assert.throws(() => writeJudge(db, { ...ok, runtime: "codex" as never }), /runtime/);
  assert.throws(() => writeJudge(db, { ...ok, model: "" }), /model/);
  assert.throws(() => writeJudge(db, { ...ok, model: "--tools" }), /model/);
  assert.throws(() => writeJudge(db, { ...ok, effort: "x".repeat(21) }), /effort/);
  assert.throws(() => writeJudge(db, { ...ok, policy: "x".repeat(4097) }), /policy/);
  assert.throws(() => writeJudge(db, "nope" as never), /judge/);
  writeJudge(db, { ...ok, policy: "x".repeat(4096) });
  assert.doesNotThrow(() => writeJudge(db, DEFAULT_JUDGE));
  assert.ok(DEFAULT_POLICY.length <= 4096);
});

test("c2_2: the default policy rates the usual safe work SAFE and the risky work UNSAFE", () => {
  const [safe, unsafe] = DEFAULT_POLICY.split(/^UNSAFE:/m);
  for (const word of ["git status", "tests", "git commit", "lockfile"]) assert.ok(safe!.includes(word), word);
  for (const word of ["git push", "publish", "credentials", "outside"]) assert.ok(unsafe!.includes(word), word);
});

const FAKE = `
const fs = require("node:fs");
let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => (stdin += d));
process.stdin.on("end", () => {
  fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ argv: process.argv.slice(2) }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "result", is_error: false, result: "SAFE" }));
});
`;

function launch(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "judge-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));
  const script = join(dir, "fake-claude.cjs");
  const log = join(dir, "calls.log");
  writeFileSync(script, FAKE);
  const calls = () =>
    existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => (JSON.parse(l) as { argv: string[] }).argv) : [];
  const env = { ...process.env, FAKE_LOG: log };
  return { calls, claude: { file: process.execPath, args: [script] }, env };
}

test("c2_3: the effort goes to claude after the model when it is set, and not when it is empty", async (t) => {
  const l = launch(t);
  const request = classifyRequest("nana", CALL, same, NONCE);
  const signal = new AbortController().signal;
  for (const effort of ["low", ""]) {
    await classify(request, signal, { models: () => ["haiku"], claude: l.claude, env: l.env, effort, timeoutMs: 5_000 });
  }
  const [withEffort, without] = l.calls();
  const at = withEffort!.indexOf("--model");
  assert.deepEqual(withEffort!.slice(at, at + 4), ["--model", "haiku", "--effort", "low"]);
  assert.ok(!without!.includes("--effort"));
});
