import fs from "node:fs";
import { join, resolve } from "node:path";

export interface ContextSetup {
  // The roster options of the agent. A value of the wrong type counts as unset.
  agent: Readonly<Record<string, unknown>>;
  projectDir: string;
  // From wikiDir in wiki/wiki.ts. Null: the wiki has no folder.
  wikiDir: string | null;
  // The owner's rules and the lounge skills go last. Unset: no such section.
  loungeRules?: string;
  skillIndex?: readonly { name: string; description: string }[];
}

interface Source {
  heading: string;
  path: string;
}

const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();

// The text a runtime without its own project files reads first.
// Read only: it never creates a file, and a missing file adds nothing.
export function buildContext(setup: ContextSetup): string {
  const { agent, projectDir, wikiDir } = setup;
  const file = typeof agent["instructionFile"] === "string" ? agent["instructionFile"].trim() : "";
  // Default on. The toggle only drops the project files that a runtime may load itself.
  const insert = agent["insertProjectFiles"] !== false;
  const sources: Source[] = [
    ...(file === "" ? [] : [{ heading: `Agent instructions (${oneLine(file)})`, path: resolve(projectDir, file) }]),
    ...(insert ? [{ heading: "Project AGENTS.md", path: join(projectDir, "AGENTS.md") }] : []),
    ...(insert ? [{ heading: "Project CLAUDE.md", path: join(projectDir, "CLAUDE.md") }] : []),
    { heading: "Project memories.md", path: join(projectDir, "memories.md") },
    ...(wikiDir === null ? [] : [{ heading: "Wiki index", path: join(wikiDir, "index.md") }]),
  ];
  let text = "";
  for (const source of sources) {
    if (!fs.existsSync(source.path)) continue;
    try {
      text += `## ${source.heading}\n\n${fs.readFileSync(source.path, "utf8").trimEnd()}\n\n`;
    } catch {
      // A folder or an unreadable file adds nothing.
    }
  }
  const skills = (setup.skillIndex ?? []).map((s) => `- ${s.name}: ${oneLine(s.description)}\n`);
  if (skills.length > 0) text += `## Lounge skills\n\n${skills.join("")}\n`;
  if ((setup.loungeRules ?? "").trim() !== "") text += `## Lounge rules\n\n${setup.loungeRules}\n\n`;
  return text;
}
