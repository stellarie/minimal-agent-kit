# Calculus checks

Nine checks from the lambda calculus. Each check has steps and a pass condition.
A check passes only on evidence: a search result, a command result, or a `file:line`. A belief is not evidence.
Record each result in the design file or the phase output. Write "fail" with the evidence when a check fails.

| Check | Phase step |
|---|---|
| pure-slice | 1.5, 2.2 Discharge, 3.2 |
| signature | 1.5, 1.7 |
| one-concern | 1.5 |
| reduction | 1.5 pseudocode, 2.2 Discharge |
| normal-form | 2.2 Refactor, 3.1 |
| confluence | 1.5 parallel marks, 3.4 |
| eta | 1.4 Subtract, 3.1 |
| termination | 2.4, 3.5 |
| lazy | 1.4 Subtract, 1.7 |

## pure-slice

A slice is a function from the state in its Pre to the state in its Post. Everything else it changes is a side effect.

Steps:

1. List the effects of the slice: files written, network calls, environment reads, global state, database writes, processes started.
2. Put each effect in the contract: a read goes in Pre, a write goes in Post.
3. After the code exists, search the diff for effects: `open(`, `write`, `fetch`, `requests.`, `os.environ`, `subprocess`, `global`, and the project's equivalents.
4. Compare the search result with the list from step 1.

Pass: each effect in the diff is in the contract. An effect not in the contract fails the check.

## signature

Write each slice as a typed function: `S#: Pre -> Post`. Then you can check the composition like types.

Steps:

1. Write the signature of each slice with named fields, for example `S2: {config: Config, rows: Row[]} -> {report: Report}`.
2. For each composition link, put the output fields of the earlier slices next to the input fields of the next slice.
3. For each input field, name its source: a field of an earlier Post, or a fact of the current system with `file:line`.
4. When the code exists, check the real signatures against the planned ones: names, types, nullability, and errors raised.

Pass: each input field has a source, and each real signature matches its plan. A field with no source is a gap. Change the slices.

## one-concern

A slice with many inputs has many reasons to fail. Cut it until each slice has one concern.

Steps:

1. Count the input fields in the signature of each slice.
2. Find each slice with more than three input fields. Ask: can a smaller slice take part of the input first? Can the rest use its result?
3. If yes, cut the slice. Write the new signatures.
4. Write one sentence for the concern of each slice. If the sentence needs "and", cut again.

Pass: each slice has a concern sentence without "and", or the design file says why the inputs cannot be split.

## reduction

The plan gives pseudocode for each slice. Implementation then replaces each line of pseudocode with real code, one step at a time. Each step keeps the meaning.

Steps in Phase 1:

1. Write pseudocode for each slice. Use the names from the signature. Keep it at the level of calls and branches, not syntax.
2. Mark each line that reuses existing code with its `file:line`.
3. Check the pseudocode against the claims: each claim maps to the lines that make it true.

```
S2: {config, rows} -> {report}
  valid = filter(rows, is_valid)         # reuse: rows.py:40
  if valid is empty: return empty_report  # claim C2.1, case (a)
  totals = sum_by(valid, config.key)      # new
  return render(totals)                   # reuse: report.py:12
```

Steps in Phase 2:

1. Replace one line of pseudocode with code.
2. Run the tests of the slice.
3. Mark the line done in the design file.
4. Does the code need a line that the pseudocode does not have? Add it to the pseudocode first. Report it in the slice output.

Pass: each pseudocode line maps to code, and each code path maps to a pseudocode line. A code path without a pseudocode line fails the check.

## normal-form

A change is done when nothing in it can reduce further.

Steps:

1. For each new function: does a caller pass its arguments through unchanged (eta)? Inline it.
2. For each new branch: can a test reach it? If not, remove it, or write the test.
3. For each new variable used once: does it name a concept? If not, inline it.
4. Search the diff for debug output, commented code, and unused imports. Use the linter if the project has one.

Pass: steps 1 to 4 find nothing, or each result has a one-line reason to stay.

## confluence

Two slices are independent when both orders give the same result. Shared files are only one way to break this.

Steps:

1. For each pair of slices marked parallel, list what each one reads and writes: files, tables, keys, environment, ports.
2. Pass the step only if no write of one slice is a read or a write of the other.
3. In Phase 3, when the slices ran in parallel, run the full test suite on the merged result. Then apply the two commits in the other order on a scratch branch. Run the suite again.

Pass: step 2 finds no overlap, and the suite passes in both orders. On a fail, run the slices in sequence.

## eta

A function that only passes its arguments to another function adds a name and no behaviour.

Steps:

1. In 1.4 Subtract, for each planned function, ask: does its body only call one other function with the same arguments?
2. In 3.1, search the diff for new functions whose body is one call. Check if the call changes any argument.

Pass: no new function is a pass-through. A pass-through can stay only for a reason in the design file. Valid reasons: a public interface, a test seam, or an extension point with a scenario.

## termination

Each loop in the workflow needs a measure that decreases each round, and a bound.

Steps:

1. Name the loops: Red and Green per scenario, fix and test (2.4), review and fix (3.5).
2. For each loop, record the measure each round: failing tests, open findings, or broken claims.
3. After each round, compare the measure with the previous round.
4. Stop when the measure does not decrease in two rounds, or after three rounds. Report to the human with the measure history.

Pass: the measure reaches zero. Record the history, for example "findings: 13, 6, 1, 0".

## lazy

Do not build or prove what no claim needs.

Steps:

1. In 1.4 Subtract, for each planned part, name the scenario or claim that needs it. Remove each part with no name.
2. In 1.7, for each proof, name the claim it supports. Give a full argument only to claims that a composition link or the Goal uses. Mark the others `tested`.
3. Do not add an option, a parameter, or a hook for a future need. Write the future need in the design file as a non-goal.

Pass: each planned part and each proof names its scenario or claim.

## Output

Put this table in the design file, and update it in Phase 2 and Phase 3:

```
## Calculus checks
| Check | Result | Evidence |
|---|---|---|
| pure-slice | pass | effects: writes out/report.json (Post S2); search: 1 hit, in contract |
| termination | pass | review findings: 4, 1, 0 |
```
