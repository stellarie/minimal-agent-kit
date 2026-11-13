# Plan file

The plan file is the design in JSON. `verify_plan.py` checks it. Keep it next to the design file, for example `.design/<task>.plan.json`.

## Format

```json
{
  "goal": "Report totals for valid rows",
  "acceptance": ["A1", "A2"],
  "parts": [{"name": "totals", "acceptance": "A1"}],
  "slices": [
    {
      "id": "S1",
      "files": ["report.py"],
      "depends": [],
      "parallel": [],
      "inputs": [{"field": "rows", "source": "rows.py:40"}],
      "outputs": ["report"],
      "effects": {"reads": ["rows.csv"], "writes": ["out/report.json"]},
      "calls": ["open", "json.dump"],
      "interface": ["report.render"],
      "scenarios": ["SC1"],
      "claims": [{"id": "C1.1", "strength": "tested", "evidence": "tests/test_report.py:12"}],
      "pseudocode": [{"line": 1, "text": "valid = filter(rows, is_valid)", "done": "report.py:20"}]
    }
  ],
  "composition": [{"id": "K0", "statement": "Current system satisfies Pre(S1)", "justification": "rows.py:40"}],
  "accepted": []
}
```

| Field | Meaning |
|---|---|
| `inputs[].source` | `S#.<output>` from a slice in `depends`, or a `file:line` in the current system |
| `effects` | Reads and writes of the slice (`pure-slice`). `confluence` compares them for parallel slices. |
| `calls` | Effect calls the slice is allowed to make, for example `open` or `requests.get` |
| `interface` | Public symbols the slice may add, change, or remove. See "Interface items". |
| `claims[].strength` | `proved`, `tested`, or `assumed` |
| `pseudocode[].done` | The code `file:line` of the line. Empty in Phase 1. |
| `accepted` | Finding IDs the human accepted, or the ID of an `assumed` claim |

Paths are relative to the project root.
Phase 1 checks only `source` and `justification` references. Phase 2 and Phase 3 also check `evidence` and `done`, because the code and tests exist then.

## Graph and quality checks

`verify_plan.py` checks the slice graph and the claims. A finding has level `fail`, unless the table says `consider`.

| ID | Meaning |
|---|---|
| `cycle:S1-S3` | Slices depend on each other, directly or through other slices. One finding per loop. |
| `depends:S3-S9` | `depends` of S3 names a slice that does not exist |
| `duplicate:slice:S1`, `duplicate:claim:C1.1` | Two slices or two claims have the same ID |
| `owner:a.py` | A file is in the `files` of two slices. This check reads `./a.py` and `a.py` as one file. |
| `parallel-depends:S1-S2` | One of two parallel slices depends on the other, directly or through other slices |
| `parallel-pair:S1-S2` | Only one of the two slices lists the other in `parallel` |
| `order:S3` | The plan lists S3 before a slice it depends on. A slice in a loop has no `order` finding. |
| `unused:S2.z` | Level `consider`. No other slice reads this output as an input `source`. |
| `uncovered:A2` | No part names this acceptance item. The check does not run when `parts` is empty. |
| `evidence:C1.1` | Phase 2 and later. A `tested` claim has no evidence in a test file, or a `proved` claim has no evidence. |
| `stale:lazy:gone` | Level `consider`. An `accepted` ID matches no finding of this run. A claim ID of the plan is never stale. |

For claim evidence, a test file is a file named like `test_*.py`, `*_test.py`, `*_test.go`, `*.test.js`, or `*.spec.ts`, or a file under `tests/`, `test/`, or `__tests__/`.
Evidence names a test file as `file:line` or as a pytest node ID, `file::name`. The file of a node ID in `evidence` must exist. Other fields do not get this check.

The scenario check reads only file names, without `*_test.go` and the test folders.
Other checks match a file in `files` as the plan spells it.
Inline tests, for example in Rust `src/lib.rs`, are not test files. The human accepts the `evidence` finding.

`ast_checks.py` adds `import-cycle:S1-S2`. Slices import each other, and one of them holds a changed file.
It adds `import-cycle:unread` at level `not-run` when it cannot read a plan file, for example a file with a syntax error.

## Interface items

`ast_checks.py` compares the public interface of each changed file at the base and at the head.

| Code | Item | Plan entry |
|---|---|---|
| Python function or class | `render(rows, config)`, `class Report` | the name, or `module.name`: `report.render` |
| JS export | `export render`, `export default` | the item, exactly |
| Express route | `route GET /users/:id` | the item, exactly |
| React props | `props Card{title,onClose}` | the new item; it covers each change to the props of `Card` |

## Finding

Each check writes findings in this form:

```json
{"id": "source:S2.config", "check": "signature", "level": "fail", "file": "", "line": 0, "detail": "input has no source"}
```

| Level | Gate |
|---|---|
| `fail` | Blocks the gate, unless `accepted` has the ID |
| `not-run` | Does not block. The report shows it. |
| `consider` | Does not block. A tool the project could add. |
| `pass` | Does not block. |
