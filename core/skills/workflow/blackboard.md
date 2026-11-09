# Blackboard

Subagents coordinate through one file: `.kit/tasks/<slug>.md`. Keep `.kit/` in `.gitignore`.

## Format

```
---
status: planning | implementing | review | done | blocked
owner: <agent name or none>
updated: YYYY-MM-DD
---

# <Task title>

## Objective
<what and why, in enough detail for a fresh agent>

## Scenarios
<BDD scenarios from the plan>

## Work Items
- [ ] W1: <one slice> | owner: none | files: <paths>
- [x] W2: <one slice> | owner: worker-a | result: <one line, commit SHA>

## Thread
[worker-a, YYYY-MM-DD] <one topic per entry>
```

## Rules

- The parent agent writes Objective, Scenarios, and Work Items.
- A subagent claims an item: it writes its name as owner before it starts.
- Never take an item with an owner other than `none`.
- Two items never edit the same file.
- Mark an item `[x]` with a one-line result when its tests pass.
- Thread is append-only. Ask questions there. Do not edit other entries.
- Write facts and file:line citations, not narration.
