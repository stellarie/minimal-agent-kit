# Phase 2: Implement

Goal: every slice meets its contract. Every claim has its evidence. Every scenario has a passing test. Use the minimal code and impact.

## Principle

Write the least code that makes the scenarios pass. Touch the fewest files and interfaces.
Each line you add is a line to read, test, and maintain. Each line you do not add costs nothing.

Before each edit, ask:

- Does a scenario fail without this line?
- Does existing code already do this?
- Does this change a public interface? If yes, is that in the plan?

## 2.1 Prepare

1. Read the approved design file again. Work from it, not from memory.
2. Make a branch if the project uses branches. Use the project's naming rule.
3. Check that the working tree is clean. Do not mix your change with unrelated edits.
4. For parallel work, write the task file (`blackboard.md`). One work item per slice.

## 2.2 Per slice

Do these steps for each slice, in plan order:

1. **Re-scan.** Read the files the slice touches, and their tests. Look again for code to reuse.
2. **Check Pre.** Confirm the Pre of the slice holds. Use the current system and the Posts of earlier slices, not their internals.
3. **Red.** Write the test for one scenario or claim. Name it from the scenario or claim ID. Run it. It must fail for the right reason.
4. **Green.** Write the smallest code that passes. Follow the project standards from the scan.
5. **Run.** Run the slice tests, then the affected suite. All pass.
6. **Discharge.** For each claim of the slice, check the argument from the design against the real code. Update each `file:line`. If the argument fails, stop (2.4).
7. **Refactor.** Remove duplication you made. Do not refactor code outside the slice.
8. **Clean.** Remove debug output, dead code, and comments that say what. Update docs your change made false.
9. **Commit.** One commit per slice, in the project's commit format.

Repeat 3 to 5 for each scenario and claim in the slice.

## 2.3 Harness use

- **Search before you read.** Use the search tool to find symbols. Read only the lines you need.
- **Edit, do not rewrite.** Change exact lines. Do not regenerate whole files.
- **Run, do not guess.** A command result is evidence. Your reading of the code is a hypothesis.
- **Long commands.** Run builds and test suites in the background when they take minutes.
- **Guard.** If the guard denies a command, do not find a way around it. Ask the human.
- **Subagents.** Use them only for independent slices. Give each one:
  - its work item and the task file path
  - the scenarios, files, and standards it needs
  - the rule: claim the item, touch only its files, report in the Thread
- **Review subagent work.** Read the diff. A report is a claim. The diff is the truth.

## 2.4 When the plan breaks

Stop when one of these occurs:

- A scenario cannot pass without a change outside the plan.
- The diff grows past the plan, for example "and while I was there".
- Three fixes for one failure do not work.
- A claim argument fails against the real code.
- A small slice grows past about 20 lines (`proof.md`).

Then report: what you found, the evidence, and two options. Wait for the human.

If the slice contract holds, redo only that slice. If the contract must change, go back to Phase 1 for that slice and each slice that depends on it. Check their K links again.
If a claim drops to `assumed`, report it. The human accepts it by ID before the work continues.

## 2.5 Output

After each slice:

```
Phase 2/4: Implement - slice <n>/<total> done
Scenarios: <ids> - pass
Claims: <ID: proved | tested | assumed>
Files: <paths> (+<added> -<removed> lines)
Commit: <sha> <message>
Notes: <deviations from the plan, or "none">
```
