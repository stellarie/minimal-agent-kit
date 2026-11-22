import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import setupCodex, { CodexAdapter, codexKind } from "../../plugins/codex/adapter.ts";
import type { AgentEntry, RuntimeKind } from "../src/roster/types.ts";
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
  over: {
    command?: string;
    commandArgs?: string[];
    env?: NodeJS.ProcessEnv;
    signedIn?: boolean;
    hardMs?: number;
    model?: string;
    effort?: string;
    sandbox?: string;
  } = {},
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
    ...(over.model ? { model: over.model } : {}),
    ...(over.effort ? { effort: over.effort } : {}),
    ...(over.sandbox ? { sandbox: over.sandbox } : {}),
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

const configValues = (argv: string[], key: string) =>
  argv.flatMap((a, i) => (argv[i - 1] === "-c" && a.startsWith(`${key}=`) ? [a] : []));
const effortValues = (argv: string[]) => argv.filter((a) => a.startsWith("model_reasoning_effort="));
const CATALOG = {
  models: [
    { id: "big", label: "Big", efforts: ["low", "high", "ultra"], default: "low" },
    { id: "small", label: "Small", efforts: ["low", "medium", "high"], default: "low" },
  ],
};

test("c5_1: a new thread gets -m and -c model_reasoning_effort", async (t) => {
  const r = rig(t, "ok", { model: "big", effort: "ultra" });
  await r.adapter.chatTurn(input(), new AbortController().signal);
  const { argv } = r.runs()[0]!;
  assert.deepEqual(argv.slice(argv.indexOf("-m"), argv.indexOf("-m") + 2), ["-m", "big"]);
  assert.deepEqual(effortValues(argv), ["model_reasoning_effort=ultra"]);
  assert.equal(argv[argv.indexOf("model_reasoning_effort=ultra") - 1], "-c");
  assert.ok(argv.indexOf("model_reasoning_effort=ultra") < argv.indexOf("exec"));
});

test("c5_1: a resumed thread gets -c model_reasoning_effort", async (t) => {
  const r = rig(t, "ok", { model: "big", effort: "high" });
  const signal = new AbortController().signal;
  await r.adapter.chatTurn(input(), signal);
  await r.adapter.chatTurn(input(), signal);
  const resumed = r.runs()[1]!.argv;
  assert.ok(resumed.includes("resume"));
  assert.deepEqual(effortValues(resumed), ["model_reasoning_effort=high"]);
  assert.equal(resumed[resumed.indexOf("model_reasoning_effort=high") - 1], "-c");
});

test("c5_1: a resumed thread gets the model of the agent, so a default model never replaces it", async (t) => {
  const r = rig(t, "ok", { model: "gpt-6.1-terra" });
  const signal = new AbortController().signal;
  await r.adapter.chatTurn(input(), signal);
  await r.adapter.chatTurn(input(), signal);
  for (const run of r.runs()) {
    const at = run.argv.indexOf("exec");
    assert.deepEqual(run.argv.slice(run.argv.indexOf("-m"), run.argv.indexOf("-m") + 2), ["-m", "gpt-6.1-terra"]);
    assert.ok(run.argv.indexOf("-m") > at, "-m is an option of exec and of exec resume");
  }
  assert.ok(r.runs()[1]!.argv.includes("resume"));
});

test("c5_1: an agent with no model passes no -m, a resumed turn too", async (t) => {
  const r = rig(t, "ok");
  const signal = new AbortController().signal;
  await r.adapter.chatTurn(input(), signal);
  await r.adapter.chatTurn(input(), signal);
  for (const run of r.runs()) assert.ok(!run.argv.includes("-m"));
});

test("c5_1: an empty effort adds no -c model_reasoning_effort", async (t) => {
  const r = rig(t, "ok", { model: "big" });
  const signal = new AbortController().signal;
  await r.adapter.chatTurn(input(), signal);
  await r.adapter.chatTurn(input(), signal);
  for (const run of r.runs()) assert.deepEqual(effortValues(run.argv), []);
});

test("c5_2: efforts(entry) gives the catalog efforts of entry.model", () => {
  const kind = codexKind(CATALOG);
  assert.deepEqual(kind.efforts({ model: "big" } as AgentEntry), ["low", "high", "ultra"]);
  assert.deepEqual(kind.efforts({ model: "small" } as AgentEntry), ["low", "medium", "high"]);
  assert.deepEqual(kind.models({} as AgentEntry), ["big", "small"]);
});

test("c5_2: an empty model gives the union of catalog efforts", () => {
  const kind = codexKind(CATALOG);
  assert.deepEqual(kind.efforts({ model: "" } as AgentEntry), ["low", "medium", "high", "ultra"]);
  assert.deepEqual(kind.efforts({ model: "typed-by-hand" } as AgentEntry), ["low", "medium", "high", "ultra"]);
});

test("c5_2: an empty catalog gives no efforts", () => {
  const kind = codexKind({ models: [] });
  assert.deepEqual([kind.efforts({ model: "big" } as AgentEntry), kind.models({} as AgentEntry)], [[], []]);
  assert.deepEqual(codexKind().efforts({ model: "" } as AgentEntry), []);
});

test("c5_3: changed lounge rules send the full context again on a resumed thread", async (t) => {
  const r = rig(t, "ok");
  const signal = new AbortController().signal;
  await r.adapter.chatTurn(input({ loungeRules: "rule one" }), signal);
  await r.adapter.chatTurn(input({ loungeRules: "rule one" }), signal);
  await r.adapter.chatTurn(input({ loungeRules: "rule two" }), signal);
  await r.adapter.chatTurn(input({ loungeRules: "rule two" }), signal);
  const [first, same, changed, again] = r.runs();
  assert.equal(count(first!.stdin, MARKER), 1);
  assert.equal(count(same!.stdin, MARKER), 0);
  assert.equal(count(changed!.stdin, MARKER), 1);
  assert.ok(changed!.stdin.includes("rule two"));
  assert.ok(changed!.argv.includes("resume"));
  assert.equal(count(again!.stdin, MARKER), 0);
});

test("codex plugin: setup reads the catalog of the lounge home and the kind lists its models", async (t) => {
  const h = tempHome();
  t.after(() => h.cleanup());
  mkdirSync(join(h.dir, "codex-home"), { recursive: true });
  writeFileSync(
    join(h.dir, "codex-home", "models_cache.json"),
    JSON.stringify({ models: [{ slug: "cached", display_name: "Cached", visibility: "list", supported_reasoning_levels: [{ effort: "low" }] }] }),
  );
  setEnv(t, "PATH", "");
  setEnv(t, "LOCALAPPDATA", join(h.dir, "none"));
  let kind: RuntimeKind | undefined;
  await setupCodex({ home: h.dir, runtime: (def) => void (kind = def) });
  assert.deepEqual(kind!.models({} as AgentEntry), ["cached"]);
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

test("c8_1: every run, a resumed one too, writes in the working folder: workspace-write and the Windows sandbox", async (t) => {
  const r = rig(t, "ok");
  const signal = new AbortController().signal;
  await r.adapter.chatTurn(input(), signal);
  await r.adapter.chatTurn(input(), signal);
  const [first, resumed] = r.runs();
  assert.ok(resumed!.argv.includes("resume"));
  for (const run of [first!, resumed!]) {
    assert.deepEqual(configValues(run.argv, "sandbox_mode"), ['sandbox_mode="workspace-write"']);
    // Without a selected Windows sandbox, codex rejects every shell call: "blocked by policy".
    assert.deepEqual(configValues(run.argv, "windows.sandbox"), ['windows.sandbox="unelevated"']);
    assert.ok(run.argv.indexOf('sandbox_mode="workspace-write"') < run.argv.indexOf("exec"));
    assert.equal(hookValues(run.argv).length, 1, "the guard hook still runs");
    assert.ok(!run.argv.includes("--dangerously-bypass-approvals-and-sandbox"));
  }
});

test("c8_1: options.sandbox sets the sandbox mode of every run", async (t) => {
  const r = rig(t, "ok", { sandbox: "read-only" });
  const signal = new AbortController().signal;
  await r.adapter.chatTurn(input(), signal);
  await r.adapter.chatTurn(input(), signal);
  for (const run of r.runs()) assert.deepEqual(configValues(run.argv, "sandbox_mode"), ['sandbox_mode="read-only"']);
});

test("c8_1: the codex kind rejects a sandbox mode that codex does not know", () => {
  const kind = codexKind();
  assert.equal(kind.validate?.({}), undefined);
  assert.equal(kind.validate?.({ sandbox: "workspace-write" }), undefined);
  assert.equal(kind.validate?.({ sandbox: "danger-full-access" }), undefined);
  assert.match(kind.validate?.({ sandbox: "everything" }) ?? "", /options.sandbox/);
});

test("c8_2: every run, a resumed one too, attaches the lounge MCP server with the token in the environment", async (t) => {
  const r = rig(t, "ok");
  const signal = new AbortController().signal;
  await r.adapter.chatTurn(input(), signal);
  await r.adapter.chatTurn(input(), signal);
  const [first, resumed] = r.runs();
  assert.ok(resumed!.argv.includes("resume"));
  for (const run of [first!, resumed!]) {
    assert.deepEqual(configValues(run.argv, "mcp_servers.lounge.url"), ['mcp_servers.lounge.url="http://127.0.0.1:4555/mcp"']);
    assert.deepEqual(configValues(run.argv, "mcp_servers.lounge.bearer_token_env_var"), [
      'mcp_servers.lounge.bearer_token_env_var="LOUNGE_GUARD_TOKEN"',
    ]);
    // Approval policy is never in exec: without this, codex fails each lounge tool call with "requires approval".
    assert.deepEqual(configValues(run.argv, "mcp_servers.lounge.default_tools_approval_mode"), [
      'mcp_servers.lounge.default_tools_approval_mode="approve"',
    ]);
    assert.ok(run.argv.indexOf('mcp_servers.lounge.url="http://127.0.0.1:4555/mcp"') < run.argv.indexOf("exec"));
    assert.ok(!run.argv.join(" ").includes("tok-123"), "the token never goes in the command line");
    assert.equal(run.guard.token, "tok-123", "the variable holds the token of the turn");
  }
});
