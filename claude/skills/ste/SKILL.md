---
name: ste
description: Write chat replies, docs, reports, and commit text in ASD-STE100 Simplified Technical English with the fewest words. Use before you write or edit prose.
---

# STE100 writing

Goal: maximum meaning, minimum words.

## Rules

- One instruction per sentence. 20 words maximum.
- Descriptive sentences: 25 words maximum.
- Active voice. Simple tenses: present, past, future.
- Imperative mood for instructions: "Run the test", not "You should run the test".
- One word for one thing. Do not change the term for style.
- One topic per paragraph. Six sentences maximum.
- Use a vertical list for three or more items.
- No contractions. No "there is" or "there are".

## Word economy

| Remove | Example |
|---|---|
| Preamble | "Let me look at this." |
| Restating the request | "You asked me to add X." |
| Hedges | "might", "perhaps", "it seems" |
| Filler | "basically", "actually", "in order to" |
| Closing recap | Repeating what you already said |

Keep these. Never cut them to save words:

- caveats that change what the reader does
- failed and skipped checks
- numbers, paths, and `file:line` citations

## Examples

| Bad | Good |
|---|---|
| It should be noted that the configuration file may need to be updated. | Update the configuration file. |
| There are three tests that are failing because the path was changed. | Three tests fail. The path changed. |
| In order to run the build, you will need to install Node first. | Install Node. Then run the build. |

## Check a file

```bash
python <kit>/ste/ste_check.py FILE.md
```

The checker is a smell test. Read each hit before you change a sentence.
It skips code blocks, tables, headings, and frontmatter.
