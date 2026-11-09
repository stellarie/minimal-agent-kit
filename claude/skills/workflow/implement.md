# Phase 2: Implement

Goal: every scenario has a passing test, with the minimal code and impact.

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
2. **Red.** Write the test for one scenario. Name it from the scenario. Run it. It must fail for the right reason.
3. **Green.** Write the smallest code that passes. Follow the project standards from the scan.
4. **Run.** Run the slice tests, then the affected suite. All pass.
5. **Refactor.** Remove duplication you made. Do not refactor code outside the slice.
6. **Clean.** Remove debug output, dead code, and comments that say what. Update docs your change made false.
7. **Commit.** One commit per slice, in the project's commit format.

Repeat 2 to 4 for each scenario in the slice.

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

Then report: what you found, the evidence, and two options. Wait for the human.

## 2.5 Output

After each slice:

```
Phase 2/4: Implement - slice <n>/<total> done
Scenarios: <ids> - pass
Files: <paths> (+<added> -<removed> lines)
Commit: <sha> <message>
Notes: <deviations from the plan, or "none">
```
