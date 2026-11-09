---
name: workflow
description: Plan and build a change in four phases with human approval gates. Use for "plan this", "build this", "fix this", or any change that needs a design.
---

# Workflow

Guiding question for every phase: what is the minimal amount of code and impact that leads to the solution?

## Phases

| Phase | Read first | Ends with |
|---|---|---|
| 1. Design | `design.md` | Human approves the design. |
| 2. Implement | `implement.md` | Every scenario has a passing test. |
| 3. Review | `review.md` | Four reviews pass. Human approves the result. |
| 4. Close | `close.md` | Wiki and memory are current. |

## Rules

- Do the phases in order. Never skip a phase or a gate.
- Read the phase file when you enter the phase. Do not work from memory of it.
- At a gate, stop. Wait for the human. Silence is not approval.
- If new evidence breaks the plan, stop. Go back to Phase 1 and tell the human what changed.
- When the human asks for a plan only, stop after Phase 1.

## Shared references

- `bdd.md`: scenario format.
- `diagram.md`: diagram style.
- `blackboard.md`: task file for subagents.

## Phase status line

Start each phase report with one line:

```
Phase <n>/4: <name> - <started | blocked | done>
```
