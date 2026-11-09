---
name: agent-memory
description: Use the forgetting-curve memory store. Read at session start, before you assume a fact about the user or a project, when you learn a durable fact, and when a remembered fact turns out wrong.
---

# Forgetting-curve memory

The memory store has two tiers.

- The **hot index** is in your context. The session-start hook prints it.
- The **cold store** holds every memory. Faded memories stay there. Search finds them.

Each memory has a strength for you alone. Strength decays with every session.
A recall strengthens the memory. A recall near the edge of forgetting strengthens it the most.

## At session start

If no "Memory index" block is in your context, show the index first.
Use the `memory_index` tool, or the CLI command `index`.

## Before you assume

A fact you do not see in the index can still exist in the cold store.

1. Search with two or three specific words: `memory_search`.
2. Recall a relevant hit by id: `memory_recall`. Only a recall counts as a use.
3. Do not recall a hit that you will not use. A recall keeps a memory hot.

## When to remember

Remember a fact that a future session needs and cannot get from the code or the history.

- A user preference or correction, with the reason.
- A decision and its constraint.
- A lesson from a failure: the trap and the fix.
- A pointer to an external resource.

Do not remember these:

- Facts that the repository already records: code structure, git history, docs.
- State that matters only to this conversation.
- Secrets, credentials, or personal data.

Use one fact per memory. Use a specific title. Add search keywords as tags.
Search first. Do not store a duplicate.

### Type

Every memory has a `type`. `memory_remember` rejects a call without one.

| Type | Use it for |
| --- | --- |
| `user` | Who the user is: role, skills, habits |
| `feedback` | A preference or a correction from the user |
| `project` | A decision, a constraint, or a lesson about one project |
| `reference` | A pointer to an external resource |

### Body template

A `feedback` or `project` body has three parts. The tool rejects it without the last two lines.

```
The rule or fact in one line.
Why: the reason, or the incident behind it.
How to apply: when and where the rule changes your action.
```

A `user` or `reference` body is free text.

### Automatic memories

A checkpoint hook can ask you to review the conversation and store memories.
A background job can also store memories. It tags them `auto` and sets the author to `capture`.
Search before you store, so that you do not duplicate an `auto` memory.
Invalidate an `auto` memory that is wrong.

## When a memory is wrong

Invalidate it with a reason: `memory_invalidate`. Then remember the correction.
An invalid memory leaves the index and default search. Validity is separate from strength.

## Pins

Pin a memory only when it must never fade, such as a hard safety rule.
A rule that applies to every session belongs in the agent instruction file, not in a pin.

## CLI fallback

If the MCP tools are not available, use the CLI. It has the same commands.

```
node <plugin-root>/bin/amem.mjs index
node <plugin-root>/bin/amem.mjs search "words to find"
node <plugin-root>/bin/amem.mjs recall <id>
node <plugin-root>/bin/amem.mjs remember --title "T" --type reference --body "B" --tags a,b
node <plugin-root>/bin/amem.mjs invalidate <id> --reason "R"
```

`<plugin-root>` is the value of `CLAUDE_PLUGIN_ROOT` or `PLUGIN_ROOT`.

Always add `--agent <name>` to a CLI command. Use the name in the index header: `# Memory index (agent: <name>, ...)`.
Without it, a shell can resolve a different agent, with a different clock and different strengths.

## Environment

- `AGENT_MEMORY_HOME` sets the store root. The default is `~/.agent-memory`.
- `AGENT_MEMORY_AGENT` sets your agent name. Each agent has its own strengths and clock.
- `AGENT_MEMORY_CAPTURE=1` marks a capture job. Every hook command then exits silently.
