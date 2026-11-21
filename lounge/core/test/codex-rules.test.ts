import { test } from "node:test";
import assert from "node:assert/strict";
import { codexStdin } from "../../plugins/codex/rules.ts";
import type { ChatTurnInput } from "../src/adapters/types.ts";

const prompt = {
  chatPrompt: (input: ChatTurnInput) => `FULL:${input.loungeRules ?? ""}`,
  turnText: () => "TURN",
};

function turn(loungeRules?: string): ChatTurnInput {
  return { loungeRules } as ChatTurnInput;
}

test("c4_1: a new thread gets the full prompt and the hash of the rules", () => {
  const got = codexStdin(undefined, turn("rule one"), prompt);
  assert.equal(got.text, "FULL:rule one");
  assert.match(got.hash, /^[0-9a-f]{64}$/);
});

test("c4_1: a resumed thread with the same rules gets only the turn text", () => {
  const first = codexStdin(undefined, turn("rule one"), prompt);
  assert.deepEqual(codexStdin({ rulesHash: first.hash }, turn("rule one"), prompt), { text: "TURN", hash: first.hash });
});

test("c4_1: changed rules, including removed rules, send the full prompt again", () => {
  const first = codexStdin(undefined, turn("rule one"), prompt);
  const changed = codexStdin({ rulesHash: first.hash }, turn("rule two"), prompt);
  assert.equal(changed.text, "FULL:rule two");
  assert.notEqual(changed.hash, first.hash);
  const removed = codexStdin({ rulesHash: first.hash }, turn(undefined), prompt);
  assert.equal(removed.text, "FULL:");
  assert.equal(codexStdin({ rulesHash: removed.hash }, turn(""), prompt).text, "TURN");
});
