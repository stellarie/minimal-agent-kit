import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { readSetting } from "../db/settings.ts";
import { CLASSIFY_MS, parseClassifier, type ClassifyRequest } from "./modes.ts";

export const MODELS_KEY = "classifier.models";
const CACHE_MAX = 500;

export interface Launcher {
  file: string;
  args: readonly string[];
}

export interface ClassifierOptions {
  // Read on every call, so a change applies at once. The list is in order.
  models: () => readonly string[];
  // For each model. The guard's own limit still caps the whole list.
  timeoutMs?: number;
  claude?: Launcher;
  env?: NodeJS.ProcessEnv;
  // Keeps SAFE answers only. Unset: no cache.
  cache?: Set<string>;
  cacheMax?: number;
}

// The whole list gets a turn at the full time per model. An empty list still gets one.
export function classifyBudget(modelCount: number, perModelMs: number = CLASSIFY_MS): number {
  return Math.max(1, modelCount) * perModelMs;
}

// A comma list, in the order of preference.
export function readModels(db: DatabaseSync): string[] {
  return (readSetting(db, MODELS_KEY) ?? "").split(",").map((m) => m.trim()).filter((m) => m !== "");
}

// Node cannot start a .cmd file without a shell, so the npm shim gives its target.
function shimTarget(cmd: string): Launcher {
  const pkg = join(dirname(cmd), "node_modules", "@anthropic-ai", "claude-code");
  const exe = join(pkg, "bin", "claude.exe");
  if (existsSync(exe)) return { file: exe, args: [] };
  const cli = join(pkg, "cli.js");
  if (existsSync(cli)) return { file: process.execPath, args: [cli] };
  throw new Error(`${cmd} needs a shell, and no claude.exe or cli.js is beside it`);
}

export function resolveClaude(env: NodeJS.ProcessEnv = process.env): Launcher {
  const names = process.platform === "win32" ? ["claude.exe", "claude.cmd"] : ["claude"];
  for (const dir of (env.PATH ?? env.Path ?? "").split(delimiter).filter((d) => d !== "")) {
    for (const name of names) {
      const file = join(dir, name);
      if (!existsSync(file)) continue;
      return name.endsWith(".cmd") ? shimTarget(file) : { file, args: [] };
    }
  }
  throw new Error("claude was not found on PATH");
}

// The call without its random marker lines, so the same call has the same key.
function cacheKey(request: ClassifyRequest): string {
  return request.user.replace(/\r\n/g, "\n").split("\n").slice(1, -1).join("\n").trim();
}

// Cut the user and project instruction files and the user settings from the call.
function runOnce(launcher: Launcher, model: string, request: ClassifyRequest, signal: AbortSignal, opts: ClassifierOptions): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      launcher.file,
      [
        ...launcher.args,
        "-p",
        "--model", model,
        "--output-format", "json",
        "--system-prompt", request.system,
        "--setting-sources", "project,local",
        "--strict-mcp-config",
        "--disable-slash-commands",
        // No tools: the call text is untrusted, so an injection has nothing to run.
        "--tools=",
      ],
      { cwd: tmpdir(), env: { ...(opts.env ?? process.env), CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1" }, stdio: ["pipe", "pipe", "ignore"], windowsHide: true },
    );
    let out = "";
    let done = false;
    const end = (fail?: Error, text?: string) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      child.kill();
      if (fail) reject(fail);
      else resolve(text ?? "");
    };
    const onAbort = () => end(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
    const timer = setTimeout(() => end(new Error("timed out")), opts.timeoutMs ?? CLASSIFY_MS);
    child.stdout.setEncoding("utf8").on("data", (d: string) => (out += d));
    child.on("error", (err) => end(err));
    child.on("close", (code) => {
      if (code !== 0) return end(new Error(`exit ${code}`));
      try {
        const reply = JSON.parse(out) as { is_error?: unknown; result?: unknown };
        if (reply.is_error === true) return end(new Error("the model gave an error"));
        if (typeof reply.result !== "string") return end(new Error("no result in the reply"));
        end(undefined, reply.result);
      } catch {
        end(new Error("the reply was not JSON"));
      }
    });
    child.stdin.on("error", () => {});
    child.stdin.end(request.user);
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
}

// An exact SAFE allows. Any other text goes back as it is, and the guard opens a card.
export async function classify(request: ClassifyRequest, signal: AbortSignal, opts: ClassifierOptions): Promise<string> {
  const key = cacheKey(request);
  if (opts.cache?.has(key)) return "SAFE";
  const models = opts.models();
  const failures: string[] = [];
  for (const model of models) {
    let text: string;
    try {
      text = await runOnce(opts.claude ?? resolveClaude(opts.env), model, request, signal, opts);
    } catch (err) {
      if (signal.aborted) throw err;
      failures.push(`${model}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    if (text.trim() === "SAFE") {
      if (opts.cache) {
        if (opts.cache.size >= (opts.cacheMax ?? CACHE_MAX)) opts.cache.delete(opts.cache.values().next().value!);
        opts.cache.add(key);
      }
      return "SAFE";
    }
    return parseClassifier(text).safe ? "UNSAFE: the reply was not an exact SAFE" : text;
  }
  throw new Error(models.length === 0 ? `no classifier model is set (${MODELS_KEY})` : `no classifier model answered: ${failures.join("; ")}`);
}
