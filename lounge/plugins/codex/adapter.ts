import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
import { resolve, win32 } from "node:path";
import type { Adapter, ChatTurnInput, ChatTurnResult } from "../../core/src/adapters/types.ts";
import { chatFolder } from "../../core/src/config.ts";
import type { AgentEntry, RuntimeContext, RuntimeKind } from "../../core/src/roster/types.ts";
import { readLine, stderrActivity, type CodexRun } from "./events.ts";
import { codexIsolationArgs, codexSignInReason } from "./isolate.ts";
import { locateCodex } from "./locate.ts";
import { codexSubagentArgs, type CodexHookEntry } from "./subagents.ts";

const SOFT_MS = 60_000;
const HARD_MS = 180_000;
const CLOSE_WAIT_MS = 5_000;
// Must outlast the guard's 580 s approval wait.
const HOOK_TIMEOUT_S = 600;
// Codex sends every shell call to the hook as Bash.
const GUARD_MATCHER = "^Bash$";

export interface CodexAdapterOptions {
  command: string;
  commandArgs: string[];
  softMs: number;
  hardMs: number;
  home: string;
  mcpUrl: () => string;
  hookFile: string;
  prompt: Pick<RuntimeContext["prompt"], "chatPrompt" | "turnText" | "isPass">;
  activity: Pick<RuntimeContext["activity"], "lineSplitter">;
  model?: string;
  // Where to look for codex. Unset: this process.
  env?: NodeJS.ProcessEnv;
}

export function guardHook(hookFile: string): CodexHookEntry {
  const command = `node "${hookFile.replace(/\\/g, "/")}"`;
  return { matcher: GUARD_MATCHER, hooks: [{ type: "command", command, timeout: HOOK_TIMEOUT_S }] };
}

// codex reads -C as a Windows path.
function windowsPath(dir: string): string {
  return process.platform === "win32" ? win32.resolve(dir) : resolve(dir);
}

function waitClose(closed: Promise<unknown>): Promise<void> {
  return new Promise((done) => {
    const timer = setTimeout(done, CLOSE_WAIT_MS);
    void closed.then(() => {
      clearTimeout(timer);
      done();
    });
  });
}

// One thread per room: a channel, else the working folder of a session.
function roomKey(input: ChatTurnInput): string {
  return input.channel ? `channel:${input.channel.id}` : `work:${input.work?.cwd ?? ""}`;
}

export class CodexAdapter implements Adapter {
  readonly name = "codex" as const;
  readonly #opts: CodexAdapterOptions;
  readonly #threads = new Map<string, string>();

  constructor(opts: CodexAdapterOptions) {
    this.#opts = opts;
  }

  async available(): Promise<{ ok: boolean; reason?: string }> {
    try {
      locateCodex(this.#opts.command, this.#opts.env);
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: (err as Error).message };
    }
  }

  async chatTurn(input: ChatTurnInput, signal: AbortSignal): Promise<ChatTurnResult> {
    if (signal.aborted) throw new Error("aborted");
    const { home, commandArgs } = this.#opts;
    const exe = locateCodex(this.#opts.command, this.#opts.env);
    const reason = await codexSignInReason(home, { command: exe, commandArgs });
    if (reason) throw new Error(reason);
    const key = roomKey(input);
    const threadId = this.#threads.get(key);
    const workDir = input.work?.cwd ?? chatFolder(home, input.agent);
    mkdirSync(workDir, { recursive: true });
    const isolation = codexIsolationArgs(home);
    const tail = threadId
      ? ["exec", "resume", threadId, "--json", "--skip-git-repo-check"]
      : ["exec", "--json", "--skip-git-repo-check", "-C", windowsPath(workDir)];
    if (!threadId && this.#opts.model) tail.push("-m", this.#opts.model);
    // The context goes in once: a resumed thread already holds it.
    const stdin = threadId ? this.#opts.prompt.turnText(input) : this.#opts.prompt.chatPrompt(input);
    const args = [
      ...commandArgs,
      ...isolation.args,
      ...codexSubagentArgs([guardHook(this.#opts.hookFile)]),
      ...tail,
      "--dangerously-bypass-hook-trust",
      "-",
    ];
    const child = spawn(exe, args, {
      shell: false,
      windowsHide: true,
      cwd: workDir,
      env: {
        ...process.env,
        ...isolation.env,
        LOUNGE_GUARD_URL: new URL(this.#opts.mcpUrl()).origin,
        LOUNGE_GUARD_TOKEN: input.mcpToken,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const run = await this.#run(child, stdin, input, signal);
    if (!run.threadId) throw new Error("codex gave no thread id");
    if (run.reply === undefined) throw new Error("codex gave no reply");
    this.#threads.set(key, run.threadId);
    return this.#opts.prompt.isPass(run.reply) ? { kind: "pass" } : { kind: "post", text: run.reply };
  }

  #run(child: ChildProcess, stdin: string, input: ChatTurnInput, signal: AbortSignal): Promise<CodexRun> {
    return new Promise<CodexRun>((resolveRun, rejectRun) => {
      const run: CodexRun = {};
      let stderr = "";
      let settled = false;
      let closed!: () => void;
      const closedP = new Promise<void>((r) => (closed = r));
      const show = (lines: string[]) => {
        for (const line of lines) {
          try {
            input.onActivity?.(line);
          } catch (err) {
            console.error("onActivity failed:", err);
          }
        }
      };
      const softTimer = setTimeout(() => input.onSlow(), this.#opts.softMs);
      const hardTimer = input.work ? undefined : setTimeout(() => stop("timeout"), this.#opts.hardMs);
      const onAbort = () => stop("aborted");
      const finish = (err?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(softTimer);
        clearTimeout(hardTimer);
        signal.removeEventListener("abort", onAbort);
        if (err) rejectRun(err);
        else resolveRun(run);
      };
      let stopping = false;
      function stop(message: string): void {
        if (settled || stopping) return;
        stopping = true;
        child.kill();
        void waitClose(closedP).then(() => finish(new Error(message)));
      }

      const { lineSplitter } = this.#opts.activity;
      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", lineSplitter((line) => show(readLine(run, line))));
      child.stderr?.on(
        "data",
        lineSplitter((line) => {
          stderr += line + "\n";
          show(stderrActivity(line));
        }),
      );
      child.stdin?.on("error", (err: NodeJS.ErrnoException) => {
        if (err.code !== "EPIPE") console.error("codex stdin error:", err);
      });
      child.on("error", (err) => {
        closed();
        finish(new Error(`codex failed to start: ${err.message}`));
      });
      child.on("close", (code) => {
        closed();
        if (stopping) return;
        if (code === 0) return finish();
        const last = stderr.split("\n").map((l) => l.trim()).filter(Boolean).pop() ?? "";
        finish(new Error(`codex exited ${code}: ${last}`));
      });
      signal.addEventListener("abort", onAbort, { once: true });
      child.stdin?.end(stdin);
    });
  }
}

export function codexKind(): RuntimeKind {
  return {
    id: "codex",
    label: "Codex",
    efforts: () => [],
    models: () => [],
    create: (entry: AgentEntry, ctx: RuntimeContext) =>
      new CodexAdapter({
        command: entry.options.command ?? "codex",
        commandArgs: entry.options.commandArgs ?? [],
        softMs: entry.options.softMs ?? SOFT_MS,
        hardMs: entry.options.hardMs ?? HARD_MS,
        home: ctx.home,
        mcpUrl: ctx.mcpUrl,
        hookFile: ctx.hookFile,
        prompt: ctx.prompt,
        activity: ctx.activity,
        ...(entry.model ? { model: entry.model } : {}),
      }),
  };
}

export default function setup(api: { runtime(def: RuntimeKind): void }): void {
  api.runtime(codexKind());
}
