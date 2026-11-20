import { z } from "zod";
import { openGate } from "../../gates/gates.ts";
import { LoungeError } from "../../lounge/room.ts";
import type { ToolModule } from "../server.ts";

const SAYS = { approved: "approved", changed: "change requested", cancelled: "cancelled" } as const;

const tool: ToolModule = {
  name: "lounge_gate",
  description:
    "Ask the owner to approve a phase of the work. Give the `phase`, a `summary`, and the `file` that holds the result. The card shows in the owner's approval stack and your turn waits. You get `approved` or `change requested`, with the owner's note. Set `room` to the thread id when you work in more than one thread.",
  input: { phase: z.string(), summary: z.string(), file: z.string().optional(), room: z.string().optional() },
  action: "lounge_gate",
  run({ phase, summary, file, room }, { caller, deps, signal }) {
    if (!deps.gates) throw new LoungeError("unsupported", "gates are not available");
    if (caller === "owner") throw new LoungeError("forbidden", "only an agent opens a gate");
    // The thread the agent works in now.
    const working = deps.threads.work().filter((w) => w.agent === caller);
    const roomId = typeof room === "string" && room !== "" ? room : working.length === 1 ? working[0]!.roomId : undefined;
    if (roomId === undefined) throw new LoungeError("bad_thread", "name the thread: set room to its id");
    return openGate(deps.gates, { agent: caller, roomId, phase, summary, file }, signal).then(({ status, note }) =>
      note ? `${SAYS[status]}: ${note}` : SAYS[status],
    );
  },
};

export default tool;
