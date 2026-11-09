import { MEMORY_TYPES } from "./frontmatter.mjs";

function formatMemory({ memory, entry, retention }) {
  const lines = [
    `# ${memory.title}`,
    `id: ${memory.id}`,
    `type: ${memory.type || "none"}`,
    `tags: ${memory.tags.join(", ") || "none"}`,
    `pinned: ${memory.pinned}`,
    `valid: ${memory.valid}${memory.valid ? "" : ` (${memory.invalid_reason})`}`,
    `author: ${memory.author}  created: ${memory.created}  updated: ${memory.updated}`,
  ];
  if (entry) {
    lines.push(`stability: ${entry.s.toFixed(2)}  uses: ${entry.uses}  retention: ${retention.toFixed(3)}`);
  }
  lines.push("", memory.body);
  return lines.join("\n");
}

function formatHits(hits) {
  if (hits.length === 0) return "No matching memories.";
  return hits
    .map(
      (hit) =>
        `- [${hit.id}] ${hit.type ? `(${hit.type}) ` : ""}${hit.title}${hit.valid ? "" : " (INVALID)"} ` +
        `(score ${hit.score}, retention ${hit.retention})\n  ${hit.snippet}`,
    )
    .join("\n");
}

const str = (description) => ({ type: "string", description });

export const TOOLS = [
  {
    name: "memory_remember",
    cli: "remember",
    description:
      "Store a durable fact, decision, or lesson. Use a specific title. One fact per memory. " +
      "A feedback or project body needs a line that starts with 'Why:' and a line that starts with 'How to apply:'.",
    inputSchema: {
      type: "object",
      properties: {
        title: str("Short, specific title."),
        type: {
          type: "string",
          enum: [...MEMORY_TYPES],
          description:
            "user: who the user is. feedback: a preference or correction. project: a decision or constraint. reference: a pointer to an external resource.",
        },
        body: str(
          "The fact. For feedback and project: the rule, then a 'Why:' line, then a 'How to apply:' line.",
        ),
        tags: { type: "array", items: { type: "string" }, description: "Search keywords." },
        pin: { type: "boolean", description: "Keep in the index forever. Use rarely." },
      },
      required: ["title", "type", "body"],
    },
    run: (store, a) => {
      const m = store.remember({
        title: a.title,
        type: a.type,
        body: a.body,
        tags: a.tags,
        pin: a.pin,
      });
      return `Remembered [${m.id}] ${m.title}`;
    },
  },
  {
    name: "memory_search",
    cli: "search",
    description:
      "Search all memories, including faded ones. Does not refresh them. Recall a hit to read it in full.",
    inputSchema: {
      type: "object",
      properties: {
        query: str("Words to search for."),
        limit: { type: "integer", description: "Maximum hits. Default 8." },
        include_invalid: { type: "boolean", description: "Also show invalidated memories." },
      },
      required: ["query"],
    },
    run: (store, a) =>
      formatHits(store.search({ query: a.query, limit: a.limit, includeInvalid: a.include_invalid })),
  },
  {
    name: "memory_recall",
    cli: "recall",
    description:
      "Read one memory in full. This counts as a use and strengthens the memory for you.",
    inputSchema: {
      type: "object",
      properties: { id: str("Memory id from the index or a search.") },
      required: ["id"],
    },
    run: (store, a) => formatMemory(store.recall(a.id)),
  },
  {
    name: "memory_pin",
    cli: "pin",
    description: "Pin a memory so it never fades from the index.",
    inputSchema: { type: "object", properties: { id: str("Memory id.") }, required: ["id"] },
    run: (store, a) => `Pinned [${store.setPinned(a.id, true).id}]`,
  },
  {
    name: "memory_unpin",
    cli: "unpin",
    description: "Unpin a memory. It then fades like any other.",
    inputSchema: { type: "object", properties: { id: str("Memory id.") }, required: ["id"] },
    run: (store, a) => `Unpinned [${store.setPinned(a.id, false).id}]`,
  },
  {
    name: "memory_invalidate",
    cli: "invalidate",
    description:
      "Mark a memory as wrong or outdated. It leaves the index and default search. Remember the correction separately.",
    inputSchema: {
      type: "object",
      properties: { id: str("Memory id."), reason: str("Why it is wrong.") },
      required: ["id", "reason"],
    },
    run: (store, a) => `Invalidated [${store.invalidate(a.id, a.reason).id}]`,
  },
  {
    name: "memory_index",
    cli: "index",
    description: "Show the hot memory index for this agent.",
    inputSchema: { type: "object", properties: {} },
    run: (store) => store.index(),
  },
];

export function findTool(name) {
  return TOOLS.find((tool) => tool.name === name || tool.cli === name);
}
