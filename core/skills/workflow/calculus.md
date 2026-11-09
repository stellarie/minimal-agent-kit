# Calculus checks

Nine checks, with names from the lambda calculus. Each check has steps and a pass condition.

A check passes only on evidence: a search result, a command result, or a `file:line`. A belief is not evidence.
Record each result in the design file or the phase output. Write "fail" with the evidence when a check fails.

In Phase 1, no code exists. Record what you planned, for example "effects listed: 2". Give pass or fail only in Phase 2 and Phase 3.

| Check | Run at |
|---|---|
| pure-slice | 1.5 step 4 (plan), 2.2 Discharge, 3 |
| signature | 1.5 step 3 (plan), 1.5 step 9, 2.2 Discharge, 3 |
| one-concern | 1.5 step 3, 3 |
| reduction | 1.5 step 5 (plan), 2.2 Green, 2.2 Discharge, 3 |
| normal-form | 2.2 Refactor, 3 |
| confluence | 1.5 step 8, 3 |
| eta | 1.5 step 5 (plan), 3 |
| termination | 1.5 step 5 (code loops), 2.2 Red and Green, 2.4, 3 |
| lazy | 1.4 (acceptance items), 1.7 step 8, 3 |

"3" means the review subagent runs the check again on the final diff. It does not copy results from the design file.

## pure-slice

A slice is a function from the state in its Pre to the state in its Post. Everything else it changes is a side effect.

Steps:

1. List the effects of the slice. Include files written or deleted, network calls, environment reads, global state, database writes, processes started, logs and stdout, and clock or random reads.
2. Put each effect in the contract: a read goes in Pre, a write goes in Post.
3. After the code exists, search the diff for effects. Use the project's I/O calls, for example `open(`, `.write(`, `unlink`, `fetch`, `requests.`, `os.environ`, `subprocess`, `print(`, `logging.`, `time.`, `random.`, `global`.
4. List each call from the diff into existing code. Check the effects of each callee, one level down.
5. Compare the results of steps 3 and 4 with the list from step 1.

Pass: each effect found in steps 3 and 4 is in the contract. The search is a lower bound. A miss found later fails the check.

## signature

Write each slice as a typed function: `S#: Pre -> Post`. Then you can check the composition like types.

Steps:

1. Write the signature of each slice with named fields, for example `S2: {config: Config, rows: Row[]} -> {report: Report}`.
2. For each composition link, put the output fields of the earlier slices next to the input fields of the next slice.
3. For each input field, name its source: a field of an earlier Post, or a fact of the current system with `file:line`.
4. When the code exists, check the real signatures against the planned ones: names, types, nullability, and errors raised.

Pass: each input field has a source, and each real signature matches its plan. A field with no source is a gap. Change the slices.

## one-concern

A slice with one concern has one reason to fail.

Steps:

1. Write the Post of each slice as one statement.
2. If the Post needs two statements that do not depend on each other, cut the slice in two.
3. For each slice with more than three input fields, check each field: is it needed to compute the Post? Remove each field that is not.
4. Write the new signatures.

Pass: each slice has one Post statement. A slice can keep two only for a cited dependency. Cite it with `file:line`: the step that computes field Y reads field X.

## reduction

The plan gives pseudocode for each slice. Implementation then replaces the pseudocode with real code, one line at a time. Each step keeps the meaning.

Steps in Phase 1:

1. Write pseudocode for each slice in its slice block (`slicing.md` template). Use the names from the signature. Keep it at the level of calls and branches, not syntax.
2. Mark each line that reuses existing code with its `file:line`.
3. Map each claim to the lines that make it true.

```
S2: {config, rows} -> {report}
  valid = filter(rows, is_valid)         # reuse: rows.py:40
  if valid is empty: return empty_report  # claim C2.1, case (a)
  totals = sum_by(valid, config.key)      # new
  return render(totals)                   # reuse: report.py:12
```

Steps in Phase 2:

1. Take the pseudocode lines that the current scenario or claim needs.
2. Replace them with code one line at a time. Run the tests of the slice after each line.
3. Annotate each done line with its code `file:line`, for example `# done: report.py:55`.
4. Does the code need a line that the pseudocode does not have? Add it to the pseudocode first.
   - A new line that adds an effect, a signature field, or a call to a public interface: stop (2.4).
   - Any other new line: report it in Notes in the slice output.

Pass: each pseudocode line has a `done:` location, and each code path in the diff maps to a pseudocode line. A code path without a line fails the check.

## normal-form

A change is done when nothing in it can reduce further.

Steps:

1. For each new function: run `eta`.
2. For each new branch: can a test reach it? If not, remove it, or write the test.
3. For each new variable used once: does it name a concept from the design? If not, inline it.

Pass: steps 1 to 3 find nothing. A result can stay only for a listed reason. Valid reasons: an `eta` reason, a test that reaches the branch, or a term from the design file.
Debris (debug output, commented code, unused imports) is the Clean step in 2.2.

## confluence

Two slices are independent when each one works without the other. Shared files are only one way to break this.

Steps:

1. For each pair of slices marked parallel, list what each one reads and writes: files, tables, keys, environment, ports.
2. Check that no write of one slice is a read or a write of the other.
3. In Phase 3, when the slices ran in parallel: apply each commit alone on the base. Run the full suite each time.
4. Run the full suite on the merged result.

Pass: step 2 finds no overlap, and the suite passes in steps 3 and 4. On a fail, run the slices in sequence. With more than two parallel slices, check each pair.

## eta

A function whose body only calls one other function with its own parameters unchanged adds a name and no behaviour.

Steps:

1. In the pseudocode, find each planned function whose body is one call with its own parameters.
2. In the final diff, search for new functions whose body is one call. Check if the call changes any parameter.

Pass: no new function is a pass-through. A pass-through can stay only for a reason in the design file. Valid reasons: a public interface, a test seam, or an extension point with a scenario.

## termination

Each loop needs a measure that decreases, and a bound. This covers the workflow loops and the loops in the code.

Steps for code:

1. For each loop or recursion in the pseudocode, write its measure and its bound, for example `# measure: len(queue), decreases each pass`.
2. In 2.2 Discharge, check the measure against the code.

Steps for the workflow:

1. The loops are: Red and Green per scenario, fix and test (2.4), and review and fix (3.5).
2. Record the measure each round. Count failing tests, or open findings that you accept as real. Do not count findings you rejected in 3.5.
3. Stop when the measure does not decrease for three consecutive rounds. Report to the human with the measure history.

Pass: each code loop has a measure in the code, and each workflow loop reaches zero. Record the history, for example "findings: 13, 6, 1, 0".

## lazy

Do not build or prove what no claim needs.

Steps:

1. In 1.4 Subtract, for each planned part, name the acceptance item that needs it. Remove each part with no name.
2. In 1.7, give a full argument to each claim that a K row or the Kg row cites. A claim that only a scenario uses needs `tested`. The small-slice rule in `proof.md` still applies. This lowers the required strength. It does not forbid a stronger proof.
3. Do not add an option, a parameter, or a hook for a future need. Write the future need in the design file as a non-goal.

Pass: each planned part names its acceptance item, and each claim has the strength its use requires.

## Output

Put this table in the design file, and update it in Phase 2 and Phase 3:

```
## Calculus checks
| Check | Result | Evidence |
|---|---|---|
| pure-slice | pass | effects: writes out/report.json (Post S2); search: 1 hit, in contract |
| termination | pass | review findings: 4, 1, 0 |
```
