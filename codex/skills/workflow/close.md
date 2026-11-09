# Phase 4: Close

Goal: the next agent starts with what this task learned.

## 4.1 Update the wiki

Use the `wiki` skill. For each item, update an existing page before you create a new one:

1. **Standards**: new or confirmed conventions.
2. **Architecture**: changed modules, data flow, or interfaces.
3. **Libraries**: added, removed, or upgraded dependencies.
4. **Decisions**: each design choice with its reason and date.
5. **Gotchas**: each trap that cost time, with its fix.

Then:

- Delete facts the change made false.
- Set `updated` and `source_commit` on each page you touched.
- Update `index.md`. Keep it at 20 lines or fewer.

## 4.2 Update memory

If the harness has cross-project memory, store only what applies outside this project:

- a human preference or correction
- a lesson about the tools or the environment

Do not store what the wiki or the repository already records.

## 4.3 Clean up

1. Mark the task file `done`, or delete it if the human does not need it.
2. Remove temporary files and branches you made, if the human agrees.
3. Leave design files in their gitignored directory.
4. Check each commit on the branch: `git log <base>..HEAD --format='%an <%ae>%n%B'`. No commit names a model, an agent, or a harness. No `Co-Authored-By` trailer for one, no "Generated with" footer, no session link. Reword a commit that has one, if the human agrees.

## 4.4 Output

```
Phase 4/4: Close - done
Wiki: <pages created or updated>
Memory: <entries stored, or "none">
Open: <follow-up work, or "none">
```
