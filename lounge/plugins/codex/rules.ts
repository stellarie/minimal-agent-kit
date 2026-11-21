import { createHash } from "node:crypto";
import type { ChatTurnInput } from "../../core/src/adapters/types.ts";
import type { RuntimeContext } from "../../core/src/roster/types.ts";

// A resumed thread holds the context of its first turn, so only changed lounge rules go in again.
export function codexStdin(
  thread: { rulesHash: string } | undefined,
  input: ChatTurnInput,
  prompt: Pick<RuntimeContext["prompt"], "chatPrompt" | "turnText">,
): { text: string; hash: string } {
  const hash = createHash("sha256").update(input.loungeRules ?? "").digest("hex");
  const same = thread !== undefined && thread.rulesHash === hash;
  return { text: same ? prompt.turnText(input) : prompt.chatPrompt(input), hash };
}
