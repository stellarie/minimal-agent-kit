---
name: wiki
description: Read, create, or update the project wiki, the long-term memory for a project. Use on task start, after analysis, and at the end of the workflow.
---

# Wiki

The wiki is the long-term memory of a project. It is one flat folder of pages. It has an `index.md`.

## Where

- Use the wiki folder the human names.
- Without a name, use `docs/wiki/` in the project folder.
- Related projects share one wiki.

## When

| Moment | Action |
|---|---|
| Task start | Read `index.md`. Read only the pages the task needs. |
| After analysis | Create or update pages with standards, reuse points, libraries, and data flow. |
| Workflow close | Add new facts, decisions, and gotchas. Update `source_commit`. |

## Page format

A page is `<kebab-topic>.md`:

```
---
title: <topic>
updated: YYYY-MM-DD
source_commit: <short sha>
tags: [standards | architecture | library | gotcha | decision]
---

## Summary
## Facts
## Decisions
## Gotchas
```

- A fact has a `file:line` source.
- A decision has a reason and a date.
- Omit an empty section.
- `index.md` has one line per page: `- [<title>](<file>.md): <summary>`.

## Read

1. Read `index.md`.
2. Open a page only when its line matches the task.
3. If `source_commit` is behind HEAD, run `git diff --stat <source_commit> HEAD -- <cited files>`.
4. If a cited file changed, check the fact before you use it.

## Create or update

1. Search first. Update an existing page before you create a new one.
2. Write each fact with a `file:line` source. A fact without a source is not a fact.
3. Delete facts that are now false. Do not add a contradicting line next to them.
4. Set `updated` to today. Set `source_commit` to the output of `git rev-parse --short HEAD`.
5. Update the line of the page in `index.md`.

## Limits

- `index.md` has 20 lines or fewer. Merge pages to stay under the limit.
- A page has 80 lines or fewer. Split by topic when it grows.
- Do not record task history or what you searched. Record conclusions.
