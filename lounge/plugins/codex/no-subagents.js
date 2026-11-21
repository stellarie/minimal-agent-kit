// Codex PreToolUse hook: a native subagent would bypass the agent graph.
// multi_agent=false does not stop the spawn, so this hook denies it.
// It also fires on the shell calls of a child, and stays silent there.
// Every tool that manages a native subagent is denied, so no thread can use one that already exists.
const DENIED = /^collaboration(?:[a-z_]+_agents?|send_input|send_message)$/;
process.stdin.toArray().then((chunks) => {
  let call;
  try {
    call = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return;
  }
  if (!DENIED.test(call?.tool_name ?? "")) return;
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
