import path from "node:path";
import { readJson, writeFileAtomic } from "./fsutil.mjs";

export const CAPTURE_GUARD = "AGENT_MEMORY_CAPTURE";

// The extractor session runs hooks too. The guard stops that recursion.
export function guarded(env = process.env) {
  return env[CAPTURE_GUARD] === "1";
}

export function safeSessionId(value) {
  const id = String(value ?? "").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 100);
  return id || "unknown";
}

export const CHECKPOINT_REASON = [
  "Memory checkpoint.",
  "Review the conversation since the last checkpoint for durable facts.",
  "Look for user preferences or corrections, decisions, lessons, and external pointers.",
  "Search first with memory_search.",
  "Then store each new fact with memory_remember.",
  "Give each memory a type: user, feedback, project, or reference.",
  'A feedback or project body needs a line that starts with "Why:" and a line that starts with "How to apply:".',
  "Store nothing that the repository already records.",
  "Store nothing that matters only now.",
  "If nothing qualifies, end with one short line.",
].join(" ");

// Returns the JSON text to print, or null when the hook must stay silent.
export function stopHook(store, input, env = process.env) {
  if (guarded(env) || input.stop_hook_active === true) return null;
  const every = Math.max(1, Math.floor(Number(store.config.nudgeEveryTurns)) || 10);
  const file = path.join(store.root, "state", "hooks", `${safeSessionId(input.session_id)}.json`);
  let turns = 0;
  try {
    turns = Number(readJson(file, {}).turns) || 0;
  } catch {
    // A broken counter file restarts the count.
  }
  turns += 1;
  writeFileAtomic(file, `${JSON.stringify({ turns })}\n`);
  if (turns % every !== 0) return null;
  return JSON.stringify({ decision: "block", reason: CHECKPOINT_REASON });
}
