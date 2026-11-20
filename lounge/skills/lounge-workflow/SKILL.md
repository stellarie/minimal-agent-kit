---
name: lounge-workflow
description: Plan and build a change in four phases with human approval gates, using the lounge tools. Use for "plan this", "build this", "fix this", or any change that needs a design.
---

# Lounge workflow

Guiding question for every phase: what is the minimal amount of code and impact that leads to the solution?

## Phases

| Phase | Work | Ends with |
|---|---|---|
| design | Scope, scenarios, slices, plan. | Human approves the plan. |
| implement | One slice at a time, test first. | Every scenario has a passing test. |
| review | A second agent checks the change. | Human approves the result. |
| close | Update the wiki. | Wiki is current. |

## Rules

- Do the phases in order. Never skip a phase or a gate.
- Silence is not approval. After you open a gate, stop and wait for the decision.
- If new evidence breaks the plan, go back to design and say what changed.
- When the human asks for a plan only, stop after design.

## Gates

At the end of design and of review, call `lounge_gate` with `phase`, `summary`, and `file`.

- `phase` is the phase you end.
- `summary` states what you ask the human to approve, in a few lines.
- `file` is the plan or the review notes.

The human sees a card with Approve and Change. The decision comes back as a post in your thread that mentions you.

- Approve: start the next phase.
- Change: read the note. Fix the work. Open the gate again.

## Design

1. Load the `wiki` skill with `lounge_skill`. Read the wiki `index.md`. Open only the pages the task needs.
2. Ask the human four or more questions in one post: goal, acceptance, constraints, non-goals. Wait for the answers.
3. Write each acceptance criterion as a scenario: Given, When, Then.
4. Split the work into slices. Each slice lists its files, its scenarios, and its pseudocode.
5. Write the plan to a file. Open a `design` gate.

## Tasks

Write one task file: `.kit/tasks/<slug>.md` in the thread folder. The blackboard panel shows it.

- The file has a status, an owner, and a list of work items.
- One work item is one slice. Two items never edit the same file.
- A worker writes its name as owner before it starts. It marks the item done with a one-line result.

## Implement

For each slice, in plan order:

1. Write one failing test from a scenario. Run it. It must fail for the right reason.
2. Write the smallest code that passes. Run the tests.
3. Remove debug output and unused code. Commit once per slice.

For independent slices, call `lounge_spawn` with `agent`, `brief`, and optional `cwd`.

- `agent` must be an agent in the roster.
- The `brief` gives the work item, the task file path, the files, and the pseudocode.
- The child thread works on its slice. Its final reply posts in your thread and mentions you.
- A child thread can start one more level of children. No deeper.
- Read the diff of each child. A report is a claim. The diff is the proof.

If a scenario needs a change outside the plan, stop. Tell the human, and give two options.

## Review

1. Start a review with `lounge_spawn`. Choose an agent other than the author.
2. Give it the diff, the plan, and the scenarios. Do not give it your conclusions.
3. Ask it to try to break each claim, and to check each `file:line`.
4. Fix each finding. Send the new diff for review again.
5. Open a `review` gate with the result.

## Close

1. Load the `wiki` skill with `lounge_skill`. Update the pages for standards, architecture, decisions, and gotchas.
2. Delete facts the change made false.
3. Mark the task file `done`.
4. Open a `close` gate if the human asked for one. Then report what you changed.
