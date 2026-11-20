// Codex PreToolUse hook: a native subagent would bypass the agent graph.
// multi_agent=false does not stop the spawn, so this hook denies it.
// It also fires on the shell calls of a child, and stays silent there.
const SPAWN = "collaborationspawn_agent";

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
});
process.stdin.on("end", () => {
  let call;
  try {
    call = JSON.parse(input);
  } catch {
    return;
  }
  if (call?.tool_name !== SPAWN) return;
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "use lounge_spawn",
      },
    }),
  );
});
