import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CodexAdapter } from "../../plugins/codex/adapter.ts";
import { CODEX_NOT_FOUND, locateCodex } from "../../plugins/codex/locate.ts";
import { CODEX_NOT_SIGNED_IN } from "../../plugins/codex/isolate.ts";
import { NO_SUBAGENTS_MATCHER } from "../../plugins/codex/subagents.ts";
import { startCore } from "../src/api/http.ts";
import { ensureTokens } from "../src/auth/tokens.ts";
import type { ChatTurnInput } from "../src/adapters/types.ts";
import type { PluginInfo } from "../src/plugins/plugins.ts";
import { HOOK_FILE } from "../src/adapters/runtimes.ts";
import { HOST_PARTS, SEED_CALLERS, tempHome } from "./helpers.ts";

const fixture = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-codex.mjs");
const MARKER = "PROJECT-CONTEXT-MARKER-7";

interface ExecEntry {
  exec?: boolean;
  argv: string[];
  stdin: string;
  cwd: string;
  exe: string;
  codexHome: string;
  guard: { url?: string; token?: string };
}

interface Rig {
  home: string;
  adapter: CodexAdapter;
  runs(): ExecEntry[];
}

function setEnv(t: TestContext, key: string, value: string): void {
  const prev = process.env[key];
  process.env[key] = value;
  t.after(() => {
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
  });
}

function rig(
  t: TestContext,
  mode: string,
  over: { command?: string; commandArgs?: string[]; env?: NodeJS.ProcessEnv; signedIn?: boolean; hardMs?: number } = {},
): Rig {
  const h = tempHome();
  t.after(() => h.cleanup());
  const log = join(h.dir, "fake.log");
  setEnv(t, "FAKE_CODEX_EXEC", mode);
  setEnv(t, "FAKE_CODEX_LOG", log);
  if (over.signedIn !== false) {
    mkdirSync(join(h.dir, "codex-home"), { recursive: true });
    writeFileSync(join(h.dir, "codex-home", "auth.json"), '{"test": true}');
  }
  const adapter = new CodexAdapter({
    command: over.command ?? process.execPath,
    commandArgs: over.commandArgs ?? [fixture],
    softMs: 60_000,
    hardMs: over.hardMs ?? 60_000,
    home: h.dir,
    mcpUrl: () => "http://127.0.0.1:4555/mcp",
    hookFile: HOOK_FILE,
    prompt: HOST_PARTS.prompt,
    activity: HOST_PARTS.activity,
    ...(over.env ? { env: over.env } : {}),
  });
  const runs = () => {
    let text = "";
    try {
      text = readFileSync(log, "utf8");
    } catch {
      return [];
    }
    return text
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as ExecEntry)
      .filter((e) => e.exec);
  };
  return { home: h.dir, adapter, runs };
}

function input(over: Partial<ChatTurnInput> = {}, lines: string[] = []): ChatTurnInput {
  return {
    agent: "bea",
    brief: "Answer the owner.",
    channel: { id: "general", topic: "" },
    context: [{ id: 1, author: "owner", text: "status?", ts: "2026-11-21T00:00:00Z" } as never],
    mcpToken: "tok-123",
    projectContext: `## Project AGENTS.md\n\n${MARKER}\n\n`,
    onActivity: (line) => lines.push(line),
    onSlow: () => {},
    ...over,
  };
}

const count = (text: string, part: string) => text.split(part).length - 1;
const hookValues = (argv: string[]) => argv.filter((a) => a.startsWith("hooks.PreToolUse="));

test("c7_1_on_path", (t) => {
  const h = tempHome();
  t.after(() => h.cleanup());
  const name = process.platform === "win32" ? "codex.exe" : "codex";
  writeFileSync(join(h.dir, name), "");
  writeFileSync(join(h.dir, "codex.cmd"), "");
  const env = { PATH: join(h.dir, "missing") + (process.platform === "win32" ? ";" : ":") + h.dir, LOCALAPPDATA: join(h.dir, "none") };
  assert.equal(locateCodex("codex", env), join(h.dir, name));
  assert.equal(locateCodex("D:/tools/codex.exe", env), "D:/tools/codex.exe");
});

test("c7_1_localappdata", (t) => {
  const h = tempHome();
  t.after(() => h.cleanup());
  const bin = join(h.dir, "OpenAI", "Codex", "bin");
  for (const d of ["old", "new"]) {
    mkdirSync(join(bin, d), { recursive: true });
    writeFileSync(join(bin, d, "codex.exe"), "");
  }
  utimesSync(join(bin, "old", "codex.exe"), new Date(2020, 1, 1), new Date(2020, 1, 1));
  assert.equal(locateCodex("codex", { PATH: "", LOCALAPPDATA: h.dir }), join(bin, "new", "codex.exe"));
});

test("c7_1_missing", (t) => {
  const h = tempHome();
  t.after(() => h.cleanup());
  writeFileSync(join(h.dir, "codex.cmd"), "");
  assert.throws(() => locateCodex("codex", { PATH: h.dir, LOCALAPPDATA: join(h.dir, "none") }), new RegExp(CODEX_NOT_FOUND));
});

test("SC12: with codex only in LOCALAPPDATA, a turn runs the newest codex.exe", async (t) => {
  const apps = tempHome();
  t.after(() => apps.cleanup());
  const bin = join(apps.dir, "OpenAI", "Codex", "bin");
  mkdirSync(join(bin, "older"), { recursive: true });
  mkdirSync(join(bin, "newer"), { recursive: true });
  writeFileSync(join(bin, "older", "codex.exe"), "");
  utimesSync(join(bin, "older", "codex.exe"), new Date(2020, 1, 1), new Date(2020, 1, 1));
  // A node binary in the codex place runs the fake.
  const exe = join(bin, "newer", "codex.exe");
  copyFileSync(process.execPath, exe);
  const r = rig(t, "ok", { command: "codex", env: { PATH: "", LOCALAPPDATA: apps.dir } });
  const result = await r.adapter.chatTurn(input(), new AbortController().signal);
  assert.deepEqual(result, { kind: "post", text: "Status is clean." });
  assert.equal(r.runs()[0]!.exe.toLowerCase(), exe.toLowerCase());
});

test("SC13: a second turn in the same room runs exec resume with the thread id, without the context", async (t) => {
  const r = rig(t, "ok");
  const signal = new AbortController().signal;
  await r.adapter.chatTurn(input(), signal);
  const second = await r.adapter.chatTurn(input(), signal);
  assert.deepEqual(second, { kind: "post", text: "PINEAPPLE" });
  await r.adapter.chatTurn(input({ channel: { id: "other", topic: "" } }), signal);
  const [first, resumed, other] = r.runs();
  const at = resumed!.argv.indexOf("exec");
  assert.deepEqual(resumed!.argv.slice(at), [
    "exec",
    "resume",
    "01a1fa06-0000-7000-8000-000000000001",
    "--json",
    "--skip-git-repo-check",
    "--dangerously-bypass-hook-trust",
    "-",
  ]);
  assert.equal(count(first!.stdin, MARKER), 1, "the first turn carries the context once");
  assert.equal(count(resumed!.stdin, MARKER), 0, "a resume sends only the turn text");
  assert.ok(resumed!.stdin.includes("status?"));
  assert.ok(!other!.argv.includes("resume"), "another room starts its own thread");
  assert.equal(count(other!.stdin, MARKER), 1);
});

test("C7_2: the first run gets exec --json, --skip-git-repo-check, a Windows -C path, and no read-only sandbox", async (t) => {
  const lines: string[] = [];
  const r = rig(t, "ok");
  const result = await r.adapter.chatTurn(input({}, lines), new AbortController().signal);
  assert.deepEqual(result, { kind: "post", text: "Status is clean." });
  const run = r.runs()[0]!;
  const at = run.argv.indexOf("exec");
  const tail = run.argv.slice(at);
  assert.deepEqual(tail.slice(0, 3), ["exec", "--json", "--skip-git-repo-check"]);
  assert.equal(tail.at(-1), "-");
  const dir = tail[tail.indexOf("-C") + 1]!;
  if (process.platform === "win32") assert.match(dir, /^[A-Za-z]:\\/);
  assert.ok(!run.argv.includes("-s") && !run.argv.includes("read-only"));
  assert.ok(run.stdin.indexOf(MARKER) < run.stdin.indexOf("status?"));
  assert.equal(run.codexHome, join(r.home, "codex-home"));
  // Activity: the command, then the earlier message once a newer one replaces it; never the trust warning.
  assert.deepEqual(lines, ["$ git status --short (exit 0, completed)", "I will check the status once."]);
});

test("C7_2: a run with no thread id or no reply shows an error", async (t) => {
  const r = rig(t, "silent");
  await assert.rejects(r.adapter.chatTurn(input(), new AbortController().signal), /codex gave no thread id/);
  const f = rig(t, "fail");
  await assert.rejects(f.adapter.chatTurn(input(), new AbortController().signal), /codex exited 1: fatal: model refused/);
});

test("C7_2: with no sign-in the turn shows the reason and starts no run", async (t) => {
  const r = rig(t, "ok", { signedIn: false });
  await assert.rejects(r.adapter.chatTurn(input(), new AbortController().signal), new RegExp(CODEX_NOT_SIGNED_IN));
  assert.equal(r.runs().length, 0);
});

test("C7_2: abort stops the run", async (t) => {
  const r = rig(t, "hang");
  const ac = new AbortController();
  const turn = r.adapter.chatTurn(input(), ac.signal);
  setTimeout(() => ac.abort(), 500);
  await assert.rejects(turn, /aborted/);
});

test("C7_3: every run passes one hooks value with the guard and no-subagents entries, and the trust bypass", async (t) => {
  const r = rig(t, "ok");
  await r.adapter.chatTurn(input(), new AbortController().signal);
  await r.adapter.chatTurn(input(), new AbortController().signal);
  for (const run of r.runs()) {
    const values = hookValues(run.argv);
    assert.equal(values.length, 1, "one -c sets the whole list");
    const value = values[0]!;
    const guard = `{matcher = "^Bash$", hooks = [{type = "command", command = ${JSON.stringify(`node "${HOOK_FILE.replace(/\\/g, "/")}"`)}, timeout = 600}]}`;
    assert.ok(value.includes(guard), value);
    assert.ok(value.indexOf("^Bash$") < value.indexOf(NO_SUBAGENTS_MATCHER));
    assert.equal(run.argv[run.argv.indexOf(value) - 1], "-c");
    assert.ok(run.argv.includes("--dangerously-bypass-hook-trust"));
    assert.deepEqual(run.guard, { url: "http://127.0.0.1:4555", token: "tok-123" });
  }
});

test("C7_3: a blocked command shows the stderr reason and the agent text", async (t) => {
  const lines: string[] = [];
  const r = rig(t, "blocked");
  const result = await r.adapter.chatTurn(input({}, lines), new AbortController().signal);
  assert.deepEqual(result, { kind: "post", text: "The hook blocked the command." });
  assert.ok(lines.includes("Command blocked by PreToolUse hook: test-deny blocked. Command: echo test-deny"), lines.join("\n"));
});

test("codex plugin: the bundled plugin loads with no error and holds the codex runtime", async (t) => {
  const home = tempHome();
  const core = await startCore({ home: home.dir, port: 0, schedule: false });
  t.after(async () => {
    await core.close();
    home.cleanup();
  });
  const tokens = ensureTokens(home.dir, SEED_CALLERS);
  const plugins = (
    (await fetch(core.url + "/api/plugins", { headers: { authorization: `Bearer ${tokens.owner!}` } }).then((r) => r.json())) as {
      plugins: PluginInfo[];
    }
  ).plugins;
  const codex = plugins.find((p) => p.id === "codex")!;
  assert.deepEqual([codex.enabled, codex.runtimes, codex.error], [true, ["codex"], undefined]);
});

const real = process.env.LOUNGE_SMOKE_CODEX === "1";
test(
  "C7_2: the real codex CLI runs a turn and a resume in a folder that is not a git repo",
  { skip: real ? false : "set LOUNGE_SMOKE_CODEX=1 to run", timeout: 300_000 },
  async (t) => {
    const h = tempHome();
    t.after(() => h.cleanup());
    // The lounge codex home needs its own sign-in: copy nothing, sign in once with Sign in to Codex.
    const homeDir = process.env.LOUNGE_SMOKE_HOME ?? h.dir;
    const adapter = new CodexAdapter({
      command: "codex",
      commandArgs: [],
      softMs: 60_000,
      hardMs: 240_000,
      home: homeDir,
      mcpUrl: () => "http://127.0.0.1:1/mcp",
      hookFile: HOOK_FILE,
      prompt: HOST_PARTS.prompt,
      activity: HOST_PARTS.activity,
    });
    const signal = new AbortController().signal;
    const one = await adapter.chatTurn(input({ brief: "Reply with the word KIWI only.", projectContext: "" }), signal);
    assert.equal(one.kind, "post");
    const two = await adapter.chatTurn(input({ brief: "Reply with the word you said last turn, only." }), signal);
    assert.equal(two.kind === "post" && two.text.trim(), "KIWI");
  },
);
