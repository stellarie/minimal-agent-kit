#!/usr/bin/env node
// PreToolUse hook for Claude Code and Codex. Reads one hook event on
// stdin, judges it with rules.js, and prints the permission decision.
// An allow outside a lounge turn prints nothing.
// In a lounge turn (LOUNGE_GUARD_URL is set) an ask waits for the
// lounge queue. Outside it, an ask in a mode that cannot prompt
// denies. Every failure denies: a hook that cannot judge must
// not allow.
// A relaxed session (a marker file for its id) prints nothing for an ask.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { judge, toAction } from "./rules.js";

const RELAX_DIR = join(homedir(), ".agent-kit", "guard-relax");

const WAIT_MS = 580_000;
const SHELL_TOOLS = new Set(["Bash", "PowerShell", "shell", "exec_command", "local_shell"]);
// In these modes a native ask does not reach a human, so it denies.
const NO_PROMPT_MODES = new Set(["bypassPermissions", "dontAsk"]);
const DECISION = { allow: "allow", ask: "ask", block: "deny" };

function emit(decision, reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: decision,
        permissionDecisionReason: `guard: ${reason}`,
      },
    }),
  );
}

async function readStdin() {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  return raw;
}

const quote = (word) => (/^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, "'\\''")}'`);

// Codex sends a command as an argv list or as `cmd`.
function shellCommand(input) {
  const raw = input?.command ?? input?.cmd;
  if (Array.isArray(raw)) return raw.map((word) => quote(String(word))).join(" ");
  return typeof raw === "string" ? raw : undefined;
}

function actionOf(event) {
  const { tool_name: tool, tool_input: input, cwd } = event;
  if (!SHELL_TOOLS.has(tool)) return toAction(tool, input, cwd);
  const command = shellCommand(input);
  return command === undefined ? undefined : toAction("Bash", { command }, cwd);
}

// The human relaxes one session with an empty file named for its id. Any doubt is false.
function relaxed(event) {
  const id = event.session_id;
  if (typeof id !== "string" || !/^[\w-]{8,128}$/.test(id)) return false;
  try {
    return existsSync(join(RELAX_DIR, id));
  } catch {
    return false;
  }
}

// The lounge core decides an ask. A queue that cannot answer denies.
async function queue(event, env) {
  if (!env.LOUNGE_GUARD_TOKEN) return ["deny", "the turn has no guard token"];
  try {
    const res = await fetch(new URL("/guard/check", env.LOUNGE_GUARD_URL), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${env.LOUNGE_GUARD_TOKEN}` },
      body: JSON.stringify({ tool: event.tool_name, input: event.tool_input, cwd: event.cwd }),
      signal: AbortSignal.timeout(WAIT_MS),
    });
    const reply = await res.json();
    if (!res.ok) return ["deny", typeof reply?.message === "string" ? reply.message : `the core answered ${res.status}`];
    if (reply?.decision === "allow") return ["allow", "the lounge allowed it"];
    return ["deny", typeof reply?.reason === "string" ? reply.reason : "the lounge denied it"];
  } catch (err) {
    return ["deny", `the lounge core did not answer (${err?.name ?? "error"})`];
  }
}

async function main(env = process.env) {
  let event;
  try {
    event = JSON.parse(await readStdin());
  } catch {
    return emit("deny", "the hook input was not JSON");
  }
  if (!event || typeof event !== "object" || Array.isArray(event)) return emit("deny", "the hook input was not an event");
  let verdict;
  try {
    verdict = judge(actionOf(event));
  } catch {
    return emit("deny", "the rules could not judge the call");
  }
  let decision = DECISION[verdict?.verdict] ?? "deny";
  let reason = verdict?.reason ?? "no rule matched";
  if (decision === "ask" && env.LOUNGE_GUARD_URL) [decision, reason] = await queue(event, env);
  else if (decision === "ask" && relaxed(event)) return;
  else if (decision === "ask" && NO_PROMPT_MODES.has(event.permission_mode)) {
    [decision, reason] = ["deny", `${reason}. This mode cannot prompt: ask the human to run it`];
  }
  // Outside a lounge turn an allow prints nothing: the harness keeps its own prompts.
  if (decision === "allow" && !env.LOUNGE_GUARD_URL) return;
  emit(decision, reason);
}

main().catch(() => emit("deny", "the hook failed"));
