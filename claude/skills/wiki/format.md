# Wiki format

## index.md

```
# Wiki index
- [<title>](<file>.md): <one-line summary>
```

## Page

File name: `<kebab-topic>.md`.

```
---
title: <topic>
updated: YYYY-MM-DD
source_commit: <short SHA>
tags: [standards | architecture | library | gotcha | decision]
---

## Summary
<two or three sentences>

## Facts
- <fact> (`path/file.ext:42`)

## Decisions
- <decision>: <reason> (YYYY-MM-DD)

## Gotchas
- <trap>: <fix>
```

Omit an empty section. Keep the section order.

## Starter pages

Create these on the first analysis of a project:

- `standards.md`: style, lint, test layout, naming.
- `architecture.md`: modules and data flow.
- `libraries.md`: dependencies in use, with versions and purpose.
