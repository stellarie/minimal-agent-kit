#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { captureRun, spawnCapture } from "../src/capture.mjs";
import { findTool } from "../src/commands.mjs";
import { guarded, stopHook } from "../src/hooks.mjs";
import { resolveAgent, Store } from "../src/store.mjs";

const USAGE = `Usage: amem <command> [options]

  remember --title T --type user|feedback|project|reference --body B [--tags a,b] [--pin]
    feedback and project bodies need a "Why:" line and a "How to apply:" line
  search <query> [--limit N] [--include-invalid]
  recall <id>
  pin <id> | unpin <id>
  invalidate <id> --reason R
  index
  stats
  session-start     hook entry: advance the session clock, print the index
  stop-hook         hook entry (Stop): every Nth turn, ask the agent to store memories
  capture           hook entry (PreCompact, idle): start a background capture and exit
  capture-run --session ID --transcript FILE
                    background job: extract memories from new transcript text

Global options:
  --agent NAME      agent name; overrides AGENT_MEMORY_AGENT
  --runtime NAME    default agent name when AGENT_MEMORY_AGENT is not set

Environment: AGENT_MEMORY_HOME (store root), AGENT_MEMORY_AGENT (agent name),
AGENT_MEMORY_CAPTURE=1 (set by capture; every hook command then exits silently),
AGENT_MEMORY_EXTRACTOR (path of a node script that replaces claude, for tests).`;

const VALUE_FLAGS = new Set([
  "title",
  "type",
  "body",
  "tags",
  "reason",
  "limit",
  "agent",
  "runtime",
  "session",
  "transcript",
]);
const BOOLEAN_FLAGS = new Set(["pin", "include_invalid"]);
const STDIN_TIMEOUT_MS = 1_000;

class UsageError extends Error {}

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--") || arg === "--") {
      positional.push(arg);
      continue;
    }
    const key = arg.slice(2).replace(/-/g, "_");
    if (BOOLEAN_FLAGS.has(key)) {
      flags[key] = true;
    } else if (VALUE_FLAGS.has(key)) {
      // A value may start with "--", so take the next argument as is.
      if (i + 1 >= argv.length) throw new UsageError(`--${arg.slice(2)} needs a value`);
      flags[key] = argv[++i];
    } else {
      throw new UsageError(`unknown option ${arg}`);
    }
  }
  return { positional, flags };
}

function readHookInput() {
  if (process.stdin.isTTY) return Promise.resolve({});
  return new Promise((resolve) => {
    let text = "";
    const done = () => {
      clearTimeout(timer);
      process.stdin.pause();
      try {
        resolve(text.trim() ? JSON.parse(text) : {});
      } catch {
        resolve({});
      }
    };
    const timer = setTimeout(done, STDIN_TIMEOUT_MS);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (text += chunk));
    process.stdin.on("end", done);
    process.stdin.on("error", done);
  });
}

// A resume or a compaction continues the same session.
async function sessionStart(flags) {
  if (guarded()) return 0;
  try {
    const input = await readHookInput();
    const store = new Store({ agent: resolveAgent(process.env, flags) });
    if (input.source !== "resume" && input.source !== "compact") store.startSession();
    console.log(store.index());
  } catch (err) {
    console.log(`Memory index unavailable: ${err.message}`);
  }
  return 0;
}

async function stopHookCommand(flags) {
  if (guarded()) return 0;
  try {
    const input = await readHookInput();
    const out = stopHook(new Store({ agent: resolveAgent(process.env, flags) }), input);
    if (out) console.log(out);
  } catch {
    // A failing hook must not block the agent from stopping.
  }
  return 0;
}

async function captureCommand(flags) {
  if (guarded()) return 0;
  try {
    spawnCapture(await readHookInput(), flags, fileURLToPath(import.meta.url));
  } catch {
    // The background job is best effort.
  }
  return 0;
}

async function captureRunCommand(flags) {
  if (!flags.session || !flags.transcript) throw new UsageError("capture-run needs --session and --transcript");
  const store = new Store({ agent: resolveAgent(process.env, flags) });
  const result = await captureRun(store, { session: flags.session, transcript: flags.transcript });
  return result.status === "error" ? 1 : 0;
}

async function main(argv) {
  const [command, ...rest] = argv;
  if (!command || command === "help" || command === "--help") {
    console.log(USAGE);
    return 0;
  }
  const { positional, flags } = parseArgs(rest);
  if (command === "session-start") return sessionStart(flags);
  if (command === "stop-hook") return stopHookCommand(flags);
  if (command === "capture") return captureCommand(flags);
  if (command === "capture-run") return captureRunCommand(flags);
  const store = new Store({ agent: resolveAgent(process.env, flags) });
  if (command === "stats") {
    console.log(JSON.stringify(store.stats(), null, 2));
    return 0;
  }
  const tool = findTool(command);
  if (!tool) throw new UsageError(`unknown command: ${command}`);
  const args = { ...flags };
  if (tool.cli === "search" && positional.length) args.query = positional.join(" ");
  if (["recall", "pin", "unpin", "invalidate"].includes(tool.cli) && positional[0]) {
    args.id = positional[0];
  }
  if (args.limit !== undefined) args.limit = Number(args.limit);
  if (typeof args.tags === "string") args.tags = args.tags.split(",");
  const missing = (tool.inputSchema.required ?? []).filter((key) => args[key] === undefined);
  if (missing.length) throw new UsageError(`${command}: missing ${missing.join(", ")}`);
  console.log(tool.run(store, args));
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    if (err instanceof UsageError) {
      console.error(`amem: ${err.message}\n\n${USAGE}`);
      process.exitCode = 2;
    } else {
      console.error(`amem: ${err.message}`);
      process.exitCode = 1;
    }
  },
);
