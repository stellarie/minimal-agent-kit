import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
import { resolve, win32 } from "node:path";
import type { Adapter, ChatTurnInput, ChatTurnResult } from "../../core/src/adapters/types.ts";
import { chatFolder } from "../../core/src/config.ts";
import type { AgentEntry, RuntimeContext, RuntimeKind } from "../../core/src/roster/types.ts";
import { readCodexCatalog } from "./catalog.ts";
import { collabEvents, readLine, stderrActivity, type CodexRun } from "./events.ts";
import { imageNames, newImages } from "./images.ts";
import { codexIsolationArgs, codexSignInReason } from "./isolate.ts";
import { locateCodex } from "./locate.ts";
import { codexStdin } from "./rules.ts";
import { codexSubagentArgs, type CodexHookEntry } from "./subagents.ts";

const SOFT_MS = 60_000;
const HARD_MS = 180_000;
const CLOSE_WAIT_MS = 5_000;
// Must outlast the guard's 580 s approval wait.
const HOOK_TIMEOUT_S = 600;
// Codex sends every shell call to the hook as Bash.
const GUARD_MATCHER = "^Bash$";
// The guard hook is the gate, so a shell call may write in the working folder.
// Codex on Windows rejects every shell call ("blocked by policy") while no sandbox is selected.
const DEFAULT_SANDBOX = "workspace-write";
const SANDBOX_MODES = ["read-only", DEFAULT_SANDBOX, "danger-full-access"];
const WINDOWS_SANDBOX = "unelevated";
// The turn environment already holds the token of the turn for the guard hook.
const TOKEN_ENV = "LOUNGE_GUARD_TOKEN";

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
  // Sent on every turn, a resumed one too: a resumed thread otherwise runs on the codex default.
  model?: string;
  // Sent on every turn, a resumed one too.
  effort?: string;
  // read-only, workspace-write, or danger-full-access. Unset: workspace-write.
  sandbox?: string;
  // The image tool of codex. Unset: on.
  images?: boolean;
  // Where to look for codex. Unset: this process.
  env?: NodeJS.ProcessEnv;
}

export function guardHook(hookFile: string): CodexHookEntry {
  const command = `node "${hookFile.replace(/\\/g, "/")}"`;
  return { matcher: GUARD_MATCHER, hooks: [{ type: "command", command, timeout: HOOK_TIMEOUT_S }] };
}

// Sent on every turn: exec resume has no -s, and a config override works for both.
export function sandboxArgs(sandbox: string = DEFAULT_SANDBOX): string[] {
  return ["-c", `sandbox_mode=${JSON.stringify(sandbox)}`, "-c", `windows.sandbox=${JSON.stringify(WINDOWS_SANDBOX)}`];
}

// Sent on every turn too. codex 0.167 has the tool on by default: a pinned value keeps a later default out.
export function imageArgs(images: boolean = true): string[] {
  return ["-c", `features.image_generation=${images}`];
}

// The lounge MCP server of this turn. The token comes from the environment, so it stays out of the command line.
// exec never asks for approval, so a tool call that needs one fails: the lounge tools are approved here,
// and the lounge core checks every call by the token.
export function mcpArgs(url: string): string[] {
  return [
    "-c",
    `mcp_servers.lounge.url=${JSON.stringify(url)}`,
    "-c",
    `mcp_servers.lounge.bearer_token_env_var=${JSON.stringify(TOKEN_ENV)}`,
    "-c",
    `mcp_servers.lounge.default_tools_approval_mode=${JSON.stringify("approve")}`,
  ];
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
  readonly #threads = new Map<string, { threadId: string; rulesHash: string }>();

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
    const thread = this.#threads.get(key);
    const threadId = thread?.threadId;
    const workDir = input.work?.cwd ?? chatFolder(home, input.agent);
    mkdirSync(workDir, { recursive: true });
    const isolation = codexIsolationArgs(home);
    const tail = threadId
      ? ["exec", "resume", threadId, "--json", "--skip-git-repo-check"]
      : ["exec", "--json", "--skip-git-repo-check", "-C", windowsPath(workDir)];
    if (this.#opts.model) tail.push("-m", this.#opts.model);
    const images = this.#opts.images !== false;
    // A new thread has no folder yet; a resumed one may hold the images of earlier turns.
    const seen = images && threadId ? imageNames(home, threadId) : new Set<string>();
    const { text: stdin, hash } = codexStdin(thread, input, this.#opts.prompt, images);
    const args = [
      ...commandArgs,
      ...isolation.args,
      ...sandboxArgs(this.#opts.sandbox),
      ...imageArgs(images),
      ...mcpArgs(this.#opts.mcpUrl()),
      ...(this.#opts.effort ? ["-c", `model_reasoning_effort=${this.#opts.effort}`] : []),
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
        [TOKEN_ENV]: input.mcpToken,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const run = await this.#run(child, stdin, input, signal);
    if (!run.threadId) throw new Error("codex gave no thread id");
    if (run.reply === undefined) throw new Error("codex gave no reply");
    this.#threads.set(key, { threadId: run.threadId, rulesHash: hash });
    const found = images ? newImages(home, run.threadId, seen) : [];
    const files = found.length > 0 ? { files: found } : {};
    return this.#opts.prompt.isPass(run.reply) ? { kind: "pass", ...files } : { kind: "post", text: run.reply, ...files };
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
      child.stdout?.on(
        "data",
        lineSplitter((line) => {
          show(readLine(run, line));
          if (!input.onSubagent) return;
          try {
            for (const sub of collabEvents(line)) input.onSubagent(sub);
          } catch (err) {
            console.error("onSubagent failed:", err);
          }
        }),
      );
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

const EFFORT_ORDER = ["low", "medium", "high", "xhigh", "max", "ultra"];

function effortRank(effort: string): number {
  const at = EFFORT_ORDER.indexOf(effort);
  return at < 0 ? EFFORT_ORDER.length : at;
}

export function codexKind(catalog: Awaited<ReturnType<typeof readCodexCatalog>> = { models: [] }): RuntimeKind {
  return {
    id: "codex",
    label: "Codex",
    efforts: (entry: AgentEntry) => {
      const model = catalog.models.find((m) => m.id === entry.model);
      if (model) return [...model.efforts];
      return [...new Set(catalog.models.flatMap((m) => m.efforts))].sort((a, b) => effortRank(a) - effortRank(b));
    },
    models: () => catalog.models.map((m) => m.id),
    validate: (options) => {
      const { sandbox, images } = options;
      if (images !== undefined && typeof images !== "boolean") return "options.images must be true or false";
      if (sandbox === undefined || (typeof sandbox === "string" && SANDBOX_MODES.includes(sandbox))) return undefined;
      return `options.sandbox must be one of ${SANDBOX_MODES.join(", ")}`;
    },
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
        ...(entry.effort ? { effort: entry.effort } : {}),
        ...(typeof entry.options.sandbox === "string" ? { sandbox: entry.options.sandbox } : {}),
        ...(typeof entry.options.images === "boolean" ? { images: entry.options.images } : {}),
      }),
  };
}

export default async function setup(api: { home: string; runtime(def: RuntimeKind): void }): Promise<void> {
  api.runtime(codexKind(await readCodexCatalog({ home: api.home })));
}
