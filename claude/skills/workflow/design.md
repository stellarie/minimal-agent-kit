# Phase 1: Design

Goal: an approved scope, a "not written" list, slices with contracts, a diagram, and a plan proved on paper.

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

Then run `calculus.md` `lazy` step 1: each planned part names its acceptance item.

## 1.5 Slice

Read `slicing.md`. Slice the work before you design the parts.

1. Write the Goal as a statement from the acceptance items.
2. Cut the work into self-contained slices. Write Pre, Post, and Invariant for each slice.
3. Write the signature of each slice (`calculus.md` `signature`). Cut each slice until it has one concern (`one-concern`).
4. List the effects of each slice and put them in its contract (`pure-slice`).
5. Write pseudocode for each slice (`reduction`). Map each claim to its lines. Give each loop a measure (`termination`). Remove pass-through functions (`eta`).
6. Write BDD scenarios (`bdd.md`) for each slice. One scenario per acceptance item. Include unhappy paths.
7. Order the slices: dependencies first, then the riskiest.
8. Mark slices that can run in parallel. Check them with `confluence`, not only by shared files.
9. Write the composition table: from the current system, through each slice, to the Goal. Check each link with `signature`.

## 1.6 Architect

1. Write a Graphviz file in the style from `diagram.md`.
2. Show components, data flow, and the boundary of the change. Show the slice for each part.
3. Mark new parts, changed parts, and reused parts. Use a legend.
4. Render it to PNG. Check the PNG for overlap before you present it.

## 1.7 Prove on paper

Read `proof.md`. Check the plan before any code exists.

1. Write the claims for each slice. Each claim is true or false and covers all accepted inputs.
2. For each claim, pick a technique: case analysis, induction, contradiction, or contract chaining.
3. Write the argument against the current code and the planned change. Cite `file:line`.
4. Give each claim and each composition link a strength: proved, tested, or assumed.
5. List failure modes. Map each one to a claim, a check, or a named residual risk.
6. If a claim or link has no argument and no source, change the slices. Do not present a plan with a gap.
7. For a small slice, use the small-slice rule in `proof.md`.
8. Set the required strength of each claim with `calculus.md` `lazy` step 2.
9. Fill the calculus checks table (`calculus.md` Output). For steps that need code, record what you planned (`calculus.md`).
10. Write the plan file next to the design file (`$VERIFY/plan.schema.md`). Run `verify_plan.py <plan> --phase 1`.
    Fix each fail, or list it for the human to accept by ID.

## 1.8 Spike

Test each assumed row and each risky K row before the human approves. Skip this step when no row needs it (`lazy`).

1. Use the spike sandbox. If it does not exist, ask the human, then run `tools/sandbox.py <dest>` once.
2. In the sandbox, make a branch `spike/<task>` from a clean `main`.
3. Write the slice under test from its pseudocode and contract. Do not copy project source.
4. Mock each dependency. Give each mock the ID of its assumed row.
5. Run each mock through the fault cases and the boundary inputs in `faults.py` or `faults.js`.
6. If a contract test needs a real dependency, install it from the target project's own manifest and lockfile, on the spike branch only. Use the exact locked version.
7. Record each row: test name, pass or fail. A pass moves the row to `tested`. A fail refutes the row: change the slices.

Spike code never enters the project. Phase 2 starts again from the pseudocode.

## 1.9 Present

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

## Goal
<statement>

## Slices
<slice template from slicing.md: signature, concern, effects, contract, files, scenarios, claims, pseudocode>

## Composition
<composition table from slicing.md>

## Scenarios
<BDD scenarios, grouped by slice>

## Proof obligations
<obligation table from proof.md>

## Calculus checks
<table from calculus.md Output>

## Plan check
<plan file path> - verify_plan.py exit <0 | 1>, <n> finding(s), <n> blocking

## Spike
| Row | Test | Result |
|---|---|---|

## Assumed
- <claim or link ID>: <statement> - source <source> - risk if false <effect>

## Failure modes
| Failure | Claim, check, or residual |
|---|---|

Approve, and accept each assumed row by ID, or tell me what to change.
```

Gate: wait for approval. Apply each change the human asks for, then present again.
