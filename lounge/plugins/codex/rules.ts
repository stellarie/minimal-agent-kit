import { createHash } from "node:crypto";
import type { ChatTurnInput } from "../../core/src/adapters/types.ts";
import type { RuntimeContext } from "../../core/src/roster/types.ts";

// The image tool of codex. The lounge posts what it makes, so the agent must not post the file again.
export const IMAGE_NOTE =
  "You can make images with your image tool. The lounge posts each one in this room with your reply. " +
  "Leave the file where it is: do not copy it, and do not send it with lounge_attach.";

// A resumed thread holds the context of its first turn, so only changed lounge rules go in again.
// A change of the image option counts as a change of the rules.
export function codexStdin(
  thread: { rulesHash: string } | undefined,
  input: ChatTurnInput,
  prompt: Pick<RuntimeContext["prompt"], "chatPrompt" | "turnText">,
  images = false,
): { text: string; hash: string } {
  const hash = createHash("sha256")
    .update(input.loungeRules ?? "")
    .update(images ? "\0images" : "")
    .digest("hex");
  const same = thread !== undefined && thread.rulesHash === hash;
  if (same) return { text: prompt.turnText(input), hash };
  const notes = images ? [...(input.notes ?? []), IMAGE_NOTE] : input.notes;
  return { text: prompt.chatPrompt(notes === undefined ? input : { ...input, notes }), hash };
}
