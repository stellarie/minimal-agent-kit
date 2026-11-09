# Agent rules

## Principle

Ask first: what is the minimal amount of code and impact that leads to the solution?
Code not written is the best code. Reuse before you write.

## Workflow

Use the `workflow` skill for any change that needs a plan. Phases:

1. Design: scan, subtract, slice, diagram, prove on paper. Write the JSON plan. Spike risky assumptions in the sandbox. Present. Wait for approval.
2. Implement: one scenario at a time. Test fails first, then passes.
3. Review and test: run the verify scripts and the completion gate.
4. Close: present the result. Update the project wiki.

## Memory

- On task start, read `docs/wiki/index.md` if it exists.
- Use the `wiki` skill to read, create, or update pages.
- A wiki fact is a hint. The code is the truth. Check before you rely on it.

## Completion gate

Before you claim success:

- Build every affected target.
- Run affected tests and the repository CI-equivalent checks.
- Run `verify_plan.py` on the plan. An open `fail` finding blocks the gate.
- Check for merge conflicts with `git merge-tree --write-tree HEAD origin/main`.
- Report each gate as passed, failed, or not run. Never report an unrun gate as passed.
- Name the degree: prototype, working, robust, or production.

## Code standards

- Follow the repository's existing style. Read it before you write.
- A comment states why, never what. Default to no comment.
- Touch only what the task needs. Report other problems; do not fix them.
- Remove debris: debug prints, dead code, stale docs your change made false.

## Safety

- Never run destructive commands. The guard denies them; do not work around it.
- Ask the human before you push, publish, or delete data.

## Writing

All chat and file output uses ASD-STE100. Use the fewest words for the full meaning.

- Lead with the result. No preamble, no restating, no closing recap.
- 20 words maximum per instruction, 25 per description.
- Active voice. Simple tenses. One topic per paragraph.
- Lists for three items or more. One word for one thing.
- No hedges or filler. Keep caveats, failures, numbers, and citations.
- The `ste` skill has the full rules. A hook checks Markdown files you write.
