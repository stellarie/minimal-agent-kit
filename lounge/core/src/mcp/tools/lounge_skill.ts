import { z } from "zod";
import { LoungeError } from "../../lounge/room.ts";
import type { ToolModule } from "../server.ts";

const tool: ToolModule = {
  name: "lounge_skill",
  description:
    "Load a lounge skill by name. You get its text. The system text lists the skills with a description of each.",
  input: { name: z.string() },
  action: "lounge_skill",
  run({ name }, { deps }) {
    if (!deps.skills) throw new LoungeError("unsupported", "skills are not available");
    return deps.skills.body(String(name));
  },
};

export default tool;
