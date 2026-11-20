import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import type { Adapter, ChatTurnInput, ChatTurnResult } from "../../core/src/adapters/types.ts";
import { chatFolder } from "../../core/src/config.ts";
import type { RuntimeContext, ToolMode } from "../../core/src/roster/types.ts";
import { claudeIsolationArgs, disallowedTools, isolationSettings } from "./isolate.ts";

export interface ClaudeAdapterOptions {
  command: string;
  commandArgs: string[];
  softMs: number;
  hardMs: number;
  home: string;
  mcpUrl: () => string;
  // The core passes its guard hook; the adapter never guesses it.
  hookFile: string;
  prompt: Pick<RuntimeContext["prompt"], "systemText" | "turnText" | "isPass">;
  activity: Pick<RuntimeContext["activity"], "claudeToolLines" | "lineSplitter">;
  // An empty value sends no flag.
  model?: string;
  effort?: string;
  // Unset or full: the guard rules alone decide.
  toolMode?: ToolMode;
}

const VERSION_LIMIT_MS = 10_000;
const CLOSE_WAIT_MS = 5_000;
const NOT_FOUND = "claude not found";
const CMD_FILE = "claude command is a .cmd file; see docs/gotchas.md";

// Node throws EINVAL for a .cmd file synchronously.
function trySpawn(...args: Parameters<typeof spawn>): ChildProcess {
  try {
    return spawn(...args);
  } catch (err) {
    throw new Error(spawnReason(err) ?? `claude failed to start: ${(err as Error).message}`);
  }
}

function spawnReason(err: unknown): string | undefined {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ENOENT") return NOT_FOUND;
  if (code === "EINVAL") return CMD_FILE;
  return undefined;
}

// Resolve the target and require it to sit strictly inside {home}/tmp.
function insideTmp(home: string, target: string): string {
  const tmp = resolve(join(home, "tmp"));
  const full = resolve(target);
  if (!full.startsWith(tmp + sep)) {
    throw new Error(`refusing to delete outside ${tmp}: ${full}`);
  }
  return full;
}

function removeInsideTmp(home: string, target: string, recursive: boolean): void {
  try {
    rmSync(insideTmp(home, target), { recursive, force: false });
  } catch (err) {
    console.error(`failed to delete ${target}:`, err);
  }
}

function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

// Wait for the close promise, but give up after CLOSE_WAIT_MS.
function waitClose(closed: Promise<unknown>): Promise<void> {
  return new Promise((done) => {
    const timer = setTimeout(done, CLOSE_WAIT_MS);
    void closed.then(() => {
      clearTimeout(timer);
      done();
    });
  });
}

function lastEventResult(stdout: string): { is_error?: boolean; result?: unknown } | undefined {
  let found: { is_error?: boolean; result?: unknown } | undefined;
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let ev: unknown;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (ev && typeof ev === "object" && (ev as { type?: unknown }).type === "result") {
      found = ev as { is_error?: boolean; result?: unknown };
    }
  }
  return found;
}

export class ClaudeAdapter implements Adapter {
  readonly name = "claude" as const;
  private readonly opts: ClaudeAdapterOptions;

  constructor(opts: ClaudeAdapterOptions) {
    this.#requireHook(opts.hookFile);
    this.opts = opts;
  }

  // Without the hook, a turn would run unguarded.
  #requireHook(hookFile: string): void {
    if (!existsSync(hookFile)) throw new Error(`guard hook not found: ${hookFile}`);
  }

  available(): Promise<{ ok: boolean; reason?: string }> {
    const { command, commandArgs } = this.opts;
    return new Promise((done) => {
      let settled = false;
      let timer: NodeJS.Timeout | undefined;
      const finish = (v: { ok: boolean; reason?: string }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        done(v);
      };
      let child: ChildProcess;
      try {
        child = trySpawn(command, [...commandArgs, "--version"], {
          shell: false,
          windowsHide: true,
          stdio: ["ignore", "ignore", "ignore"],
        });
      } catch (err) {
        finish({ ok: false, reason: (err as Error).message });
        return;
      }
      timer = setTimeout(() => {
        child.kill();
        finish({ ok: false, reason: "claude --version timed out" });
      }, VERSION_LIMIT_MS);
      child.on("error", (err) => {
        finish({ ok: false, reason: spawnReason(err) ?? `claude failed to start: ${err.message}` });
      });
      child.on("close", (code) => {
        finish(code === 0 ? { ok: true } : { ok: false, reason: `claude --version exited ${code}` });
      });
    });
  }

  async chatTurn(input: ChatTurnInput, signal: AbortSignal): Promise<ChatTurnResult> {
    if (signal.aborted) throw new Error("aborted");
    // The file may have gone since the adapter was built.
    this.#requireHook(this.opts.hookFile);
    const { home } = this.opts;
    const tmpRoot = join(home, "tmp");
    mkdirSync(tmpRoot, { recursive: true });
    const dir = mkdtempSync(join(tmpRoot, "turn-"));
    let child: ChildProcess | undefined;
    let closed: Promise<unknown> = Promise.resolve();
    try {
      const systemPath = join(dir, "system.md");
      const mcpPath = join(dir, "mcp.json");
      const settingsPath = join(dir, "settings.json");
      writeFileSync(settingsPath, JSON.stringify(isolationSettings(this.opts.hookFile)));
      writeFileSync(systemPath, this.opts.prompt.systemText(input));
      const mcp = {
        mcpServers: {
          lounge: {
            type: "http",
            url: this.opts.mcpUrl(),
            headers: { Authorization: `Bearer ${input.mcpToken}` },
          },
        },
      };
      writeFileSync(mcpPath, JSON.stringify(mcp), { mode: 0o600 });
      const prompt = this.opts.prompt.turnText(input);
      const workDir = input.work?.cwd ?? chatFolder(home, input.agent);
      mkdirSync(workDir, { recursive: true });
      const isolation = claudeIsolationArgs({ mcpPath, settingsPath });
      const args = [
        ...this.opts.commandArgs,
        ...isolation.args,
        "--append-system-prompt-file",
        systemPath,
        "--output-format",
        "stream-json",
        "--verbose",
      ];
      if (this.opts.model) args.push("--model", this.opts.model);
      if (this.opts.effort) args.push("--effort", this.opts.effort);
      // The = form: a list after the flag must not take the next argument.
      args.push(disallowedTools(this.opts.toolMode));
      if (input.readDirs && input.readDirs.length > 0) args.push("--add-dir", ...input.readDirs);
      // Print mode cannot ask: allow the granted tools.
      if (input.allowedTools && input.allowedTools.length > 0) {
        args.push("--allowedTools", input.allowedTools.join(","));
      }
      const proc = trySpawn(this.opts.command, args, {
        shell: false,
        windowsHide: true,
        cwd: workDir,
        env: {
          ...process.env,
          ...isolation.env,
          LOUNGE_GUARD_URL: new URL(this.opts.mcpUrl()).origin,
          LOUNGE_GUARD_TOKEN: input.mcpToken,
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
      child = proc;
      return await this.run(proc, prompt, input, signal, (p) => {
        closed = p;
      });
    } finally {
      if (child) {
        if (!hasExited(child)) child.kill();
        await waitClose(closed);
      }
      removeInsideTmp(home, dir, true);
    }
  }

  private run(
    child: ChildProcess,
    prompt: string,
    input: ChatTurnInput,
    signal: AbortSignal,
    setClosed: (p: Promise<unknown>) => void,
  ): Promise<ChatTurnResult> {
    return new Promise<ChatTurnResult>((resolveTurn, rejectTurn) => {
      let stdout = "";
      let stderr = "";
      let settled = false;
      let killing = false;
      let softTimer: NodeJS.Timeout | undefined;
      let hardTimer: NodeJS.Timeout | undefined;

      let markClosed!: () => void;
      const closedP = new Promise<void>((r) => {
        markClosed = r;
      });
      setClosed(closedP);

      const onAbort = () => killThen("aborted");
      const cleanup = () => {
        clearTimeout(softTimer);
        clearTimeout(hardTimer);
        signal.removeEventListener("abort", onAbort);
      };
      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        rejectTurn(err);
      };
      const killThen = (message: string) => {
        if (settled || killing) return;
        killing = true;
        cleanup();
        child.kill();
        void waitClose(closedP).then(() => fail(new Error(message)));
      };

      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      const onActivity = input.onActivity;
      const { claudeToolLines, lineSplitter } = this.opts.activity;
      const feed = onActivity
        ? lineSplitter((line) => {
            let ev: unknown;
            try {
              ev = JSON.parse(line);
            } catch {
              return;
            }
            for (const tool of claudeToolLines(ev)) {
              try {
                onActivity(tool);
              } catch (err) {
                console.error("onActivity failed:", err);
              }
            }
          })
        : undefined;
      child.stdout?.on("data", (d: string) => {
        stdout += d;
        feed?.(d);
      });
      child.stderr?.on("data", (d: string) => {
        stderr += d;
      });
      child.stdin?.on("error", (err: NodeJS.ErrnoException) => {
        // A child that exits early closes the pipe; its exit path reports why.
        if (err.code !== "EPIPE") console.error("claude stdin error:", err);
      });
      child.on("error", (err) => {
        markClosed();
        fail(new Error(spawnReason(err) ?? `claude failed to start: ${err.message}`));
      });
      child.on("close", (code) => {
        markClosed();
        if (settled || killing) return;
        if (code !== 0) {
          // The CLI puts errors such as a missing login in the result.
          const errorResult = lastEventResult(stdout);
          if (errorResult?.is_error === true && typeof errorResult.result === "string" && errorResult.result) {
            fail(new Error(`claude exited ${code}: ${errorResult.result}`));
            return;
          }
          const last = stderr.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).pop() ?? "";
          fail(new Error(`claude exited ${code}: ${last}`));
          return;
        }
        const result = lastEventResult(stdout);
        if (!result) {
          fail(new Error("claude gave no result"));
          return;
        }
        const text = typeof result.result === "string" ? result.result : "";
        if (result.is_error === true) {
          fail(new Error(text || "claude reported an error"));
          return;
        }
        settled = true;
        cleanup();
        resolveTurn(this.opts.prompt.isPass(text) ? { kind: "pass" } : { kind: "post", text });
      });

      softTimer = setTimeout(() => {
        try {
          input.onSlow();
        } catch (err) {
          console.error("onSlow failed:", err);
        }
      }, this.opts.softMs);
      // Work runs until done or stopped.
      if (!input.work) hardTimer = setTimeout(() => killThen("timeout"), this.opts.hardMs);
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();

      child.stdin?.end(prompt);
    });
  }
}
