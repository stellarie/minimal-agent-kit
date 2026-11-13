---
name: wiki
description: Read, create, or update the project wiki, the long-term memory for a project or a group of related projects. Takes an optional wiki name or path. Use on task start, after analysis, and at the end of the workflow.
---

# Wiki

The wiki is the long-term memory. Follow `format.md` for every page.

## Where

Two environment variables set the location. A blank value counts as unset.

- `WIKI_ROOT` unset: the wiki is `docs/wiki/` in the project. A name has no effect.
- `WIKI_ROOT` set: the wiki is one flat folder, `$WIKI_ROOT/<name>/`.
- `WIKI_ROOT` must be an absolute path or start with `~`. `~` expands to the home directory.
- `<name>` is the skill argument. Without an argument, it is `WIKI_NAME`. Without both, it is the name of the project directory.
- `WIKI_NAME` is a plain folder name, not a path. The hook refuses a value with `/` or `\` or a drive prefix, on every platform.
- An argument with a path separator, or with a leading `~` or `.`, is a path. It names the folder directly, whatever `WIKI_ROOT` says.
- Any other argument is a name.
- Related projects share one wiki. Give each of them the same name.
- The session hook uses `WIKI_NAME` or the name of the directory where the session starts.

## When

| Moment | Action |
|---|---|
| Task start | Read `index.md`. Read only the pages the task needs. |
| After analysis | Create or update pages with standards, reuse points, libraries, data flow. |
| Workflow close | Add new facts, decisions, and gotchas. Update `source_commit`. |

## Read

1. Read `index.md`.
2. Open a page only when its line matches the task.
3. If `source_commit` is behind HEAD, run `git diff --stat <source_commit> HEAD -- <cited files>`. If a cited file changed, verify the fact before you use it.

## Create or update

1. Search first: `grep -ril "<topic>" <wiki folder>`. Update an existing page before you create a new one.
2. Write facts with a `file:line` citation. A fact without a source is not a fact.
3. Delete facts that are now false. Do not add a contradicting line next to them.
4. Set `updated` to today and `source_commit` to `git rev-parse --short HEAD`.
5. Update the page's line in `index.md`.

## Limits

- `index.md` has 20 lines or fewer. Merge pages to stay under the limit.
- A page has 80 lines or fewer. Split by topic when it grows.
- Do not record task history or what you searched. Record conclusions.
