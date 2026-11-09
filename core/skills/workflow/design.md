# Phase 1: Design

Goal: an approved scope, a "not written" list, a diagram, and a plan.

## 1.1 Recall

1. Read `docs/wiki/index.md`. Open each page that matches the task.
2. Search cross-project memory if the harness has it, for example `memory_search`.
3. For each wiki page you use, check that its `source_commit` is current for the cited files.
4. Note what you know, and what you still need to find.

## 1.2 Ask and scope

Ask the human at least four leading questions in one message. Cover:

1. **Goal**: what outcome proves success? Who or what uses it?
2. **Acceptance**: which behaviour must pass? Which can wait?
3. **Constraints**: deadline, compatibility, performance, platforms, files not to touch.
4. **Non-goals**: what must this change not do?

Add more questions for each open risk. Expound each question in one or two sentences:

- why the answer changes the design
- your default answer, if the human has none

Ask only what the code, wiki, and memory cannot answer. Wait for the answers.
If an answer is unclear, ask again. Do not guess a load-bearing answer.

## 1.3 Scan

Read the code only to fill gaps the wiki left. Record:

- **Standards**: style, lint, formatter, test layout, naming, commit format.
- **Reuse**: functions, modules, scripts, and configs that solve part of the task. Give `file:line`.
- **Libraries**: dependencies in use, with versions. Prefer these over new ones.
- **Blast radius**: every caller and consumer of the code you will change. Derive the list with a search. Do not pick it by hand.

## 1.4 Subtract

Answer the guiding question in writing. For each part of the solution, ask in this order:

1. Can we skip it? Does an acceptance item fail without it?
2. Does existing code do it? Reuse it.
3. Does a library in use do it? Call it.
4. Does config, data, or a script do it? Prefer that to new code.
5. Only then: write new code, in the smallest unit that passes.

Impact counts as cost too. Prefer the change that touches fewer files, callers, and public interfaces.

## 1.5 Architect

1. Write a Graphviz file in the style from `diagram.md`.
2. Show components, data flow, and the boundary of the change.
3. Mark new parts, changed parts, and reused parts. Use a legend.
4. Render it to PNG. Check the PNG for overlap before you present it.

## 1.6 Plan

1. Write BDD scenarios (`bdd.md`). One scenario per acceptance item. Include unhappy paths.
2. Cut the work into slices. Each slice has its own scenarios and leaves the system working.
3. Put the riskiest slice first.
4. List failure modes. Map each one to a check or a named residual risk.
5. Mark slices that can run in parallel. Two parallel slices never touch the same file.

## 1.7 Present

Write the design file in a gitignored directory. Show the human this structure, then stop:

```
Phase 1/4: Design - done

## Scope
Goal: <one line>
In: <list>
Out (non-goals): <list>

## Answers used
- Q1 <question>: <answer>

## Scan
Standards: <list>
Reuse: <item> (`file:line`)
Libraries: <name version>
Blast radius: <callers and consumers>

## Not written
| Not written | Use instead |
|---|---|

## Architecture
<path to PNG>

## Scenarios
<BDD scenarios>

## Slices
1. <slice> - scenarios <ids> - files <paths> - risk <high | medium | low>

## Failure modes
| Failure | Check or residual |
|---|---|

Approve, or tell me what to change.
```

Gate: wait for approval. Apply each change the human asks for, then present again.
