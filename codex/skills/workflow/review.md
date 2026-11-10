# Phase 3: Review

Goal: proof that the change is correct, minimal, and does what the human asked.

Do four reviews. One subagent does all four reviews. The author of the change never reviews its own work.

| Harness | Model | Effort |
|---|---|---|
| Claude Code | Opus 5.5 (`claude-opus-5-5`) | medium |
| Codex | Sol 6.1 | light |

Give the subagent only these inputs:

- the diff, or the base and head commits
- the design file and its scenarios
- this file, `proof.md`, `slicing.md`, and `calculus.md`
- the plan file, and the output of the scripts in 3.4 step 6

Do not give it your conclusions. A fresh reader does not share your assumptions.

The subagent reviews by refutation. For each claim and composition link in the obligation table (`proof.md`):

1. Try to build a counterexample: an input, a state, or a call order that makes the claim false.
2. Check each `file:line` in the argument against the code at the head commit.
3. Check that the strength is honest. A `proved` row with a gap is `tested` at best.
4. Report each row: holds, broken with the counterexample, or weaker than stated.

A broken claim with its contract unchanged sends its slice back to Phase 2.
A fix that changes a contract sends the slice and each slice that depends on it back to Phase 1. Check their K links again.
A broken composition link sends the plan back to Phase 1.

The subagent also runs each check in `calculus.md` again on the final diff. For `termination`, it runs only the steps for code. When slices ran in parallel, it runs `confluence` steps 3 and 4.
The parent, not the subagent, records the review-round history in 3.6.
It reports each result with its evidence. It does not copy the results from the design file.

The subagent returns findings. You fix them (3.5), then send the new diff for review again.
Repeat until no open finding remains, or `calculus.md` `termination` stops the loop. Count only the findings you accept as real.

If the harness cannot start a subagent, stop. Tell the human. Do not review the work yourself.

## 3.1 Code review

Read the full diff: `git diff <base>...HEAD`. Check:

1. **Correctness.** Logic errors, off-by-one, null and empty input, error paths, resource leaks.
2. **Security.** Input validation, injection, secrets, permissions.
3. **Standards.** Style, naming, and structure match the scan.
4. **Minimal code.** A scenario needs each added line. No dead code, no speculative options, no duplicated helpers.
5. **Comments.** Each comment states why. Delete the ones that state what.

## 3.2 Implementation review

Compare the diff with the approved design:

1. Each "not written" item is still not written.
2. The diff calls each reuse item. It does not copy it.
3. The diff touches only planned files. Explain each extra file.
4. Each consumer in the blast radius still works with the change.
5. The diff updates each doc and wiki page that the change made false.

## 3.3 Behaviour review

Exercise the real flow, not only the tests:

1. Run the program, command, or endpoint as a user would.
2. Do each scenario's When step. Observe the Then outcome.
3. Try one unhappy path per scenario: bad input, missing file, failed dependency.
4. Record what you saw. Report a step you cannot run as "not run".

## 3.4 Tests

1. Run the full test suite and the repository CI-equivalent checks.
2. Build every affected target.
3. Check that each scenario has a test, or a named manual check.
4. For a bug fix, undo the fix. Confirm the regression test fails. Restore the fix.
5. Check for merge conflicts without a merge: `git merge-tree --write-tree HEAD origin/<main>`.
6. Run the scripts, then the plan check with their findings:
   ```
   python $VERIFY/ast_checks.py <plan> --base <base> --phase 3 > ast.json
   python $VERIFY/check_tools.py --base <base> > tools.json
   python $VERIFY/minimal_check.py --base <base> --test "<test command>" > minimal.json
   python $VERIFY/verify_plan.py <plan> --phase 3 --findings ast.json tools.json minimal.json
   ```
   The exit code of `verify_plan.py` is the gate. Report each "consider" and "not-run" line as a note to the human.
   A `minimal:` fail is a hunk the tests do not need. Remove it, add a test that needs it, or ask the human to accept its ID.

## 3.5 Fix

For each finding:

- Real: fix it, add a test if a test can catch it, and run the affected checks again.
- Not real: write one line on why.

## 3.6 Output

Present this, then stop:

```
Phase 3/4: Review - done

## Gate
| Check | Result | Evidence |
|---|---|---|
| Build | pass / fail / not run | <command> |
| Tests | pass / fail / not run | <n passed, n failed> |
| CI checks | pass / fail / not run | <command> |
| Merge conflicts | none / found / not run | <command> |
| Regression proof | pass / not applicable | <test name> |
| Plan check | pass / fail | verify_plan.py: <n> blocking |
| Project tools | pass / fail / not run | <tool: result>; consider: <tools> |

## Reviews
Code: <findings fixed, or "clean">
Implementation: <deviations, or "matches design">
Behaviour: <scenario: observed outcome>

## Claims
| ID | Strength | Refutation result |
|---|---|---|

## Calculus checks
| Check | Result | Evidence |
|---|---|---|
Review rounds: <finding count per round, for example 4, 1, 0>

## New assumed rows
- <claim or link ID>: <statement> - new or downgraded since the last acceptance

Accept each new assumed row by ID. Do not list rows the human accepted in Phase 2.

## Diff
<n files, +added -removed lines>

## Residual risks
- <risk>: <why it stays>

Degree: prototype | working | robust | production
Approve to close, or tell me what to change.
```

Gate: wait for approval. Never report an unrun check as passed.
