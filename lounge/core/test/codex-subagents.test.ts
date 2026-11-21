import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  NO_SUBAGENTS_FILE,
  NO_SUBAGENTS_MATCHER,
  codexSubagentArgs,
  noSubagentsHook,
} from "../../plugins/codex/subagents.ts";

function hook(input: unknown): string {
  const run = spawnSync(process.execPath, [NO_SUBAGENTS_FILE], { input: JSON.stringify(input), encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  return run.stdout;
}

test("C15_5: the no-subagents hook denies collaborationspawn_agent with the reason use lounge_spawn", () => {
  assert.ok(existsSync(NO_SUBAGENTS_FILE));
  const out = JSON.parse(hook({ session_id: "s", turn_id: "t", tool_name: "collaborationspawn_agent", tool_input: {} }));
  assert.deepEqual(out, {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: "use lounge_spawn",
    },
  });
});

test("c6_1: the no-subagents hook denies every collaboration agent tool, send_input, and send_message", () => {
  const names = [
    "collaborationspawn_agent",
    "collaborationwait_agent",
    "collaborationinterrupt_agent",
    "collaborationlist_agents",
    "collaborationclose_agent",
    "collaborationsend_input",
    "collaborationsend_message",
  ];
  for (const tool_name of names) {
    const out = JSON.parse(hook({ tool_name, tool_input: {} }));
    assert.equal(out.hookSpecificOutput.permissionDecision, "deny", tool_name);
  }
});

test("c6_1: the no-subagents hook denies every tool the matcher sends, whatever its name", () => {
  for (const tool_name of ["collaborationnote", "collaborationresume_agent", "collaboration", "collaborationfuture_tool"]) {
    assert.ok(new RegExp(NO_SUBAGENTS_MATCHER).test(tool_name), tool_name);
    const out = JSON.parse(hook({ tool_name, tool_input: {} }));
    assert.equal(out.hookSpecificOutput.permissionDecision, "deny", tool_name);
  }
});

test("c6_1: the no-subagents hook stays silent for tools the matcher does not send", () => {
  assert.equal(hook({ tool_name: "Bash", tool_input: { command: "echo collaborationspawn_agent" } }), "");
  assert.equal(hook({ tool_name: "mcp__collaborationspawn_agent", tool_input: {} }), "");
  assert.equal(hook({ tool_input: {} }), "");
});

test("c6_1: the no-subagents hook fails closed on unparseable input", () => {
  for (const input of ["not json", "", "{"]) {
    const run = spawnSync(process.execPath, [NO_SUBAGENTS_FILE], { input, encoding: "utf8" });
    assert.equal(run.status, 0);
    const out = JSON.parse(run.stdout);
    assert.equal(out.hookSpecificOutput.permissionDecision, "deny", JSON.stringify(input));
    assert.equal(out.hookSpecificOutput.permissionDecisionReason, "use lounge_spawn");
  }
});

test("C15_5: codexSubagentArgs adds a second PreToolUse hook after the guard hook, with no feature flag", () => {
  const guard = { matcher: "Bash", hooks: [{ type: "command" as const, command: 'node "C:/g/guard.js"' }] };
  const args = codexSubagentArgs([guard]);
  assert.equal(args.length, 2);
  assert.equal(args[0], "-c");
  assert.ok(!args.some((a) => /multi_agent/.test(a)));
  const value = args[1]!;
  assert.match(value, /^hooks\.PreToolUse=\[/);
  assert.ok(value.indexOf('"Bash"') < value.indexOf(`"${NO_SUBAGENTS_MATCHER}"`), "the guard hook stays first");
  assert.equal(NO_SUBAGENTS_MATCHER, "^collaboration");
  const entry = noSubagentsHook();
  assert.equal(entry.matcher, "^collaboration");
  assert.match(entry.hooks[0]!.command, /^node ".*no-subagents\.js"$/);
  assert.ok(!entry.hooks[0]!.command.includes("\\"), "forward slashes only");
});
