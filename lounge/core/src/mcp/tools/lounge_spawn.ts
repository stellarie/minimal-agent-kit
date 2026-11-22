import { z } from "zod";
import { LoungeError } from "../../lounge/room.ts";
import type { ToolModule } from "../server.ts";

const tool: ToolModule = {
  name: "lounge_spawn",
  description:
    "Start a subagent: a roster agent leads a child thread of your current work thread. " +
    "Her final reply comes back into your thread and mentions you. The cwd defaults to your thread folder. " +
    "After you spawn, end your turn. Do not poll or wait: the final reply wakes you.",
  input: { agent: z.string(), brief: z.string(), cwd: z.string().optional() },
  action: "thread_start",
  run({ agent, brief, cwd }, { caller, deps, roomId }) {
    if (!deps.children) throw new LoungeError("unsupported", "child threads are not available");
    const info = deps.children.spawnChild(caller, deps.children.parentFor(caller, roomId), { agent, brief, cwd });
    return { id: info.id, lead: info.lead, cwd: info.cwd };
  },
};

export default tool;
