// Codex PreToolUse hook: a native subagent would bypass the agent graph.
// multi_agent=false does not stop the spawn, so this hook denies it.
// It also fires on the shell calls of a child, and stays silent there.
// Every collaboration tool is denied, the same set the matcher sends, so no thread can use one that already exists.
// Input that does not parse is denied too: the hook fails closed.
const DENIED = /^collaboration/;
function deny() {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "use lounge_spawn",
      },
    }),
  );
}
process.stdin.toArray().then((chunks) => {
  let call;
  try {
    call = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    deny();
    return;
  }
  if (DENIED.test(call?.tool_name ?? "")) deny();
});
