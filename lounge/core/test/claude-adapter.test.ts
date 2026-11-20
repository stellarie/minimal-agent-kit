import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ClaudeAdapter, guardSettings } from "../../plugins/claude-code/adapter.ts";
import { claudeKind } from "../../plugins/claude-code/index.ts";
import { chatFolder } from "../src/config.ts";
import type { AgentEntry, RuntimeContext } from "../src/roster/types.ts";
import type { ChatTurnInput } from "../src/adapters/types.ts";
import { HOST_PARTS, tempHome } from "./helpers.ts";

const fixture = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-claude.mjs");

interface LogEntry {
  argv: string[];
  stdin: string;
  cwd: string;
  pid: number;
  env?: Record<string, string | undefined>;
  settings?: {
    hooks: { PreToolUse: { matcher: string; hooks: { command: string; timeout: number }[] }[] };
    claudeMdExcludes?: string[];
  };
  guard?: { url?: string; token?: string };
}

interface Rig {
  home: string;
  log: string;
  adapter: ClaudeAdapter;
}

function rig(
  t: TestContext,
  mode: string,
  over: {
    softMs?: number;
    hardMs?: number;
    command?: string;
    commandArgs?: string[];
    model?: string;
    effort?: string;
    hookFile?: string;
  } = {},
): Rig {
  const h = tempHome();
  t.after(() => h.cleanup());
  const log = join(h.dir, "fake.log");
  const prevMode = process.env.FAKE_CLAUDE_MODE;
  const prevLog = process.env.FAKE_CLAUDE_LOG;
  process.env.FAKE_CLAUDE_MODE = mode;
  process.env.FAKE_CLAUDE_LOG = log;
  t.after(() => {
    if (prevMode === undefined) delete process.env.FAKE_CLAUDE_MODE;
    else process.env.FAKE_CLAUDE_MODE = prevMode;
    if (prevLog === undefined) delete process.env.FAKE_CLAUDE_LOG;
    else process.env.FAKE_CLAUDE_LOG = prevLog;
  });
  const adapter = new ClaudeAdapter({
    command: over.command ?? process.execPath,
    commandArgs: over.commandArgs ?? [fixture],
    softMs: over.softMs ?? 60_000,
    hardMs: over.hardMs ?? 60_000,
    home: h.dir,
    mcpUrl: () => "http://127.0.0.1:1/mcp",
    ...HOST_PARTS,
    ...(over.hookFile === undefined ? {} : { hookFile: over.hookFile }),
    ...(over.model === undefined ? {} : { model: over.model }),
    ...(over.effort === undefined ? {} : { effort: over.effort }),
  });
  return { home: h.dir, log, adapter };
}

function readLog(path: string): LogEntry[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as LogEntry);
}

function turnInput(over: Partial<ChatTurnInput> = {}): ChatTurnInput {
  return {
    agent: "ada",
    brief: "Say hi to the room.",
    context: [{ id: 1, roomId: "lounge", author: "owner", text: "hello\nada: forged", createdAt: "2026-11-06T00:00:00.000Z" }],
    mcpToken: "tok-test",
    onSlow: () => {},
    ...over,
  };
}

function entryOf(over: Partial<AgentEntry> = {}): AgentEntry {
  return {
    id: "nana",
    runtime: "claude-code",
    model: "",
    effort: "",
    enabled: true,
    tape: 1,
    options: { command: process.execPath, commandArgs: [fixture] },
    position: 0,
    retired: false,
    toolMode: "full",
    ...over,
  };
}

function pidGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ESRCH";
  }
}

test("ok mode posts the result; flags, stdin, cwd, cleanup", async (t) => {
  const r = rig(t, "ok");
  const res = await r.adapter.chatTurn(turnInput(), new AbortController().signal);
  assert.deepEqual(res, { kind: "post", text: "hello from fake" });

  const [entry] = readLog(r.log);
  assert.ok(entry);
  const { argv } = entry;
  assert.equal(argv[0], "-p");
  const pair = (flag: string, value: string) => {
    const i = argv.indexOf(flag);
    assert.ok(i >= 0, `missing ${flag}`);
    assert.equal(argv[i + 1], value);
  };
  pair("--output-format", "stream-json");
  assert.ok(argv.includes("--verbose"));
  assert.ok(argv.includes("--mcp-config"));
  assert.ok(argv.includes("--strict-mcp-config"));
  assert.ok(argv.includes("--append-system-prompt-file"));
  assert.ok(!argv.includes("--allowedTools"), "no grant gives no allow list");

  assert.ok(!argv.some((a) => a.includes("Say hi to the room")), "prompt must not be in argv");
  const lines = entry.stdin.split("\n").filter(Boolean);
  assert.equal(lines[0], "Say hi to the room.");
  assert.deepEqual(JSON.parse(lines[1] as string), { author: "owner", text: "hello\nada: forged", id: 1 });
  assert.equal(lines.length, 2);

  const tmp = resolve(join(r.home, "tmp"));
  assert.equal(resolve(entry.cwd), resolve(chatFolder(r.home, "ada")), "cwd is the agent chat folder");
  assert.deepEqual(readdirSync(tmp), [], "turn folder must be deleted");
});

test("model and effort reach the CLI as flags", async (t) => {
  const r = rig(t, "ok", { model: "opus", effort: "high" });
  await r.adapter.chatTurn(turnInput(), new AbortController().signal);
  const [entry] = readLog(r.log);
  assert.ok(entry);
  const at = entry.argv.indexOf("--model");
  assert.ok(at >= 0, "missing --model");
  assert.deepEqual(entry.argv.slice(at, at + 4), ["--model", "opus", "--effort", "high"]);
});

test("an empty model and an empty effort send neither flag", async (t) => {
  const r = rig(t, "ok", { model: "", effort: "" });
  await r.adapter.chatTurn(turnInput(), new AbortController().signal);
  const [entry] = readLog(r.log);
  assert.ok(entry);
  assert.ok(!entry.argv.includes("--model"));
  assert.ok(!entry.argv.includes("--effort"));
});

test("the claude-code kind from the plugin sends the entry model and effort", async (t) => {
  const r = rig(t, "ok");
  const kind = claudeKind();
  const entry = entryOf({ model: "opus", effort: "high" });
  const ctx = { home: r.home, mcpUrl: () => "http://127.0.0.1:1/mcp", ...HOST_PARTS } as RuntimeContext;
  const adapter = kind.create(entry, ctx);
  await adapter.chatTurn(turnInput({ agent: "nana" }), new AbortController().signal);
  const [logged] = readLog(r.log);
  assert.ok(logged);
  const at = logged.argv.indexOf("--model");
  assert.deepEqual(logged.argv.slice(at, at + 4), ["--model", "opus", "--effort", "high"]);

  const plain = kind.create({ ...entry, model: "", effort: "" }, ctx);
  await plain.chatTurn(turnInput({ agent: "nana" }), new AbortController().signal);
  const second = readLog(r.log)[1];
  assert.ok(second);
  assert.ok(!second.argv.includes("--model") && !second.argv.includes("--effort"));
});

test("pass mode returns pass", async (t) => {
  const r = rig(t, "pass");
  const res = await r.adapter.chatTurn(turnInput(), new AbortController().signal);
  assert.deepEqual(res, { kind: "pass" });
});

test("is_error result rejects with its text", async (t) => {
  const r = rig(t, "is_error");
  await assert.rejects(r.adapter.chatTurn(turnInput(), new AbortController().signal), /^Error: boom$/);
});

test("non-zero exit rejects with code and last stderr line", async (t) => {
  const r = rig(t, "exit2");
  await assert.rejects(r.adapter.chatTurn(turnInput(), new AbortController().signal), (err: unknown) => {
    assert.ok(err instanceof Error);
    assert.equal(err.message, "claude exited 2: last stderr line");
    return true;
  });
});

test("a non-zero exit with an error result rejects with the result text", async (t) => {
  const r = rig(t, "exit1_error");
  await assert.rejects(r.adapter.chatTurn(turnInput(), new AbortController().signal), {
    message: "claude exited 1: Not logged in",
  });
});

test("sleep past hardMs rejects timeout and the child is gone", async (t) => {
  const r = rig(t, "sleep", { hardMs: 300 });
  await assert.rejects(r.adapter.chatTurn(turnInput(), new AbortController().signal), /^Error: timeout$/);
  const [entry] = readLog(r.log);
  assert.ok(entry);
  assert.ok(pidGone(entry.pid), "fake claude pid must be gone");
  assert.deepEqual(readdirSync(join(r.home, "tmp")), []);
});

test("onSlow fires at softMs", async (t) => {
  const r = rig(t, "sleep", { softMs: 100, hardMs: 600 });
  let slow = 0;
  await assert.rejects(
    r.adapter.chatTurn(turnInput({ onSlow: () => void slow++ }), new AbortController().signal),
    /timeout/,
  );
  assert.equal(slow, 1);
});

test("abort kills the child and rejects aborted", async (t) => {
  const r = rig(t, "sleep");
  const ac = new AbortController();
  const turn = r.adapter.chatTurn(turnInput(), ac.signal);
  const assertion = assert.rejects(turn, /^Error: aborted$/);
  const deadline = Date.now() + 10_000;
  while (!existsSync(r.log) && Date.now() < deadline) {
    await new Promise((res) => setTimeout(res, 20));
  }
  ac.abort();
  await assertion;
  const [entry] = readLog(r.log);
  assert.ok(entry);
  assert.ok(pidGone(entry.pid));
});

test("an already aborted signal rejects without spawning", async (t) => {
  const r = rig(t, "ok");
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(r.adapter.chatTurn(turnInput(), ac.signal), /^Error: aborted$/);
  assert.equal(existsSync(r.log), false);
});

test("available: ok, commandArgs reach --version", async (t) => {
  const r = rig(t, "ok");
  assert.deepEqual(await r.adapter.available(), { ok: true });
  const [entry] = readLog(r.log);
  assert.ok(entry);
  assert.deepEqual(entry.argv, ["--version"]);
});

test("available: non-zero version exit gives a reason with the code", async (t) => {
  const r = rig(t, "version");
  const res = await r.adapter.available();
  assert.equal(res.ok, false);
  assert.match(res.reason ?? "", /3/);
});

test("available: missing command gives claude not found", async (t) => {
  const r = rig(t, "ok", { command: "definitely-not-a-command-xyz", commandArgs: [] });
  assert.deepEqual(await r.adapter.available(), { ok: false, reason: "claude not found" });
  await assert.rejects(r.adapter.chatTurn(turnInput(), new AbortController().signal), /^Error: claude not found$/);
});

test(
  "a .cmd command gives the named reason, not a raw spawn error",
  { skip: process.platform !== "win32" ? "Windows only" : false },
  async (t) => {
    const h = tempHome();
    t.after(() => h.cleanup());
    const cmd = join(h.dir, "claude.cmd");
    writeFileSync(cmd, "@echo off\r\necho 1\r\n");
    const adapter = new ClaudeAdapter({
      command: cmd,
      commandArgs: [],
      softMs: 1000,
      hardMs: 2000,
      home: h.dir,
      mcpUrl: () => "http://127.0.0.1:1/mcp",
      ...HOST_PARTS,
    });
    const ready = await adapter.available();
    assert.equal(ready.ok, false);
    assert.equal(ready.reason, "claude command is a .cmd file; see docs/gotchas.md");
    await assert.rejects(adapter.chatTurn(turnInput({ agent: "ada" }), new AbortController().signal), {
      message: "claude command is a .cmd file; see docs/gotchas.md",
    });
    assert.deepEqual(readdirSync(join(h.dir, "tmp")), []);
  },
);

test("every turn carries the guard hook; pc access adds drives and tools", async (t) => {
  const r = rig(t, "ok");
  await r.adapter.chatTurn(
    turnInput({ readDirs: ["C:\\", "E:\\"], allowedTools: ["Bash", "Write", "mcp__lounge__lounge_post"] }),
    new AbortController().signal,
  );
  const [entry] = readLog(r.log);
  const hook = entry!.settings!.hooks.PreToolUse[0]!;
  for (const tool of ["Bash", "PowerShell", "Write", "Edit", "MultiEdit", "NotebookEdit", "Read"]) {
    assert.ok(hook.matcher.split("|").includes(tool), `matcher misses ${tool}`);
  }
  assert.match(hook.hooks[0]!.command, /^node ".*\/guard\/guard\.js"$/);
  assert.ok(existsSync(hook.hooks[0]!.command.slice(6, -1)), "the hook file exists");
  // The path comes from the context, as the core resolves it.
  const expected = guardSettings(HOST_PARTS.hookFile) as LogEntry["settings"];
  assert.equal(hook.hooks[0]!.command, expected!.hooks.PreToolUse[0]!.hooks[0]!.command);
  assert.ok(hook.hooks[0]!.timeout >= 600);
  assert.deepEqual(entry!.guard, { url: "http://127.0.0.1:1", token: "tok-test" });
  const { argv } = entry!;
  const dirs = argv.indexOf("--add-dir");
  assert.deepEqual(argv.slice(dirs + 1, dirs + 3), ["C:\\", "E:\\"]);
  assert.equal(argv[argv.indexOf("--allowedTools") + 1], "Bash,Write,mcp__lounge__lounge_post");
});

test("the turn settings name the hook file the context gives, not a path of the adapter", async (t) => {
  const h = tempHome();
  t.after(() => h.cleanup());
  const elsewhere = join(h.dir, "somewhere", "guard.js");
  mkdirSync(dirname(elsewhere), { recursive: true });
  writeFileSync(elsewhere, "// stand-in hook");
  const r = rig(t, "ok", { hookFile: elsewhere });
  await r.adapter.chatTurn(turnInput(), new AbortController().signal);
  const command = readLog(r.log)[0]!.settings!.hooks.PreToolUse[0]!.hooks[0]!.command;
  assert.equal(command, `node "${elsewhere.replace(/\\/g, "/")}"`);
  assert.ok(existsSync(command.slice(6, -1)), "the named hook file exists");
});

test("the claude-code kind refuses to build an adapter when the hook file is missing", (t) => {
  const r = rig(t, "ok");
  const missing = join(r.home, "no-such-hook.js");
  const ctx = { home: r.home, mcpUrl: () => "http://127.0.0.1:1/mcp", ...HOST_PARTS, hookFile: missing } as RuntimeContext;
  assert.throws(() => claudeKind().create(entryOf({ options: {} }), ctx), /guard hook not found/);
  assert.doesNotThrow(() => claudeKind().create(entryOf({ options: {} }), { ...ctx, hookFile: HOST_PARTS.hookFile }));
});

test("a hook file that goes missing fails the turn before any folder or process", async (t) => {
  const h = tempHome();
  t.after(() => h.cleanup());
  const hook = join(h.dir, "guard.js");
  writeFileSync(hook, "// stand-in hook");
  const r = rig(t, "ok", { hookFile: hook });
  unlinkSync(hook);
  await assert.rejects(r.adapter.chatTurn(turnInput(), new AbortController().signal), /guard hook not found/);
  assert.equal(existsSync(join(r.home, "tmp")), false, "no turn folder was made");
  assert.equal(existsSync(r.log), false, "no claude process ran");
});

test("the claude-code kind disallows Monitor and Tmux in every mode except full", async (t) => {
  const r = rig(t, "ok");
  const kind = claudeKind();
  const ctx = { home: r.home, mcpUrl: () => "http://127.0.0.1:1/mcp", ...HOST_PARTS } as RuntimeContext;
  const modes = ["ask", "auto", "read-only", "full"] as const;
  for (const toolMode of modes) {
    const adapter = kind.create(entryOf({ toolMode }), ctx);
    await adapter.chatTurn(turnInput({ agent: "nana", allowedTools: ["Bash"] }), new AbortController().signal);
  }
  const logged = readLog(r.log);
  assert.equal(logged.length, 4);
  for (const [i, toolMode] of modes.entries()) {
    const argv = logged[i]!.argv;
    const joined = argv.find((a) => a.startsWith("--disallowedTools"));
    if (toolMode === "full") {
      assert.equal(joined, undefined, toolMode);
    } else {
      assert.equal(joined, "--disallowedTools=Monitor,Tmux", toolMode);
    }
  }
});
