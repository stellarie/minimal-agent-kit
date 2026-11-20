// Codex PreToolUse hook: a native subagent would bypass the agent graph.
// multi_agent=false does not stop the spawn, so this hook denies it.
// It also fires on the shell calls of a child, and stays silent there.
process.stdin.toArray().then((chunks) => {
  let call;
  try {
    call = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return;
  }
  if (call?.tool_name !== "collaborationspawn_agent") return;
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
