---
name: workflow
description: Plan and build a change in four phases with human approval gates. Use for "plan this", "build this", "fix this", or any change that needs a design.
---

# Workflow

Guiding question for every phase: what is the minimal amount of code and impact that leads to the solution?

## Phases

| Phase | Read first | Ends with |
|---|---|---|
| 1. Design | `design.md` | Human approves the slices, the proof obligations, and each assumed claim. |
| 2. Implement | `implement.md` | Every slice meets its contract. Every scenario has a passing test. |
| 3. Review | `review.md` | Four reviews pass. Human approves the result. |
| 4. Close | `close.md` | Wiki and memory are current. |

## Rules

- Do the phases in order. Never skip a phase or a gate.
- Read the phase file when you enter the phase. Do not work from memory of it.
- At a gate, stop. Wait for the human. Silence is not approval.
- If new evidence breaks the plan, stop. Go back to Phase 1 and tell the human what changed.
- When the human asks for a plan only, stop after Phase 1.

## Shared references

- `slicing.md`: slices with contracts, and the composition table.
- `proof.md`: claims, strength, proof techniques, and the obligation table.
- `calculus.md`: nine checks with steps and pass conditions: purity, signatures, one concern, pseudocode reduction, normal form, confluence, eta, termination, laziness.
- `bdd.md`: scenario format.
- `$VERIFY/plan.schema.md`: the plan file in JSON, and the finding format.

## Scripts

`$VERIFY` is the `verify/` directory of the kit install: `${CLAUDE_PLUGIN_ROOT}/verify` on Claude Code, `~/.codex/kit/verify` on Codex.

| Script | Checks |
|---|---|
| `verify_plan.py PLAN --phase N` | Plan structure. Merges the other findings. Its exit code is a gate. |
| `ast_checks.py PLAN --base REV` | Changed Python and JS code against the plan: files, `eta`, effects, `done` lines, public interface |
| `check_tools.py --base REV` | The check tools the project has configured. A missing tool is a note, not a fail. |

The spike sandbox comes from `tools/sandbox.py` in the kit checkout. Its `README.md` gives the spike steps.
- `diagram.md`: diagram style.
- `blackboard.md`: task file for subagents.

## Phase status line

Start each phase report with one line:

```
Phase <n>/4: <name> - <started | blocked | done>
```
