# Plan file

The plan file is the design in JSON. `verify_plan.py` checks it. Keep it next to the design file, for example `.design/<task>.plan.json`.

## Format

```json
{
  "goal": "Report totals for valid rows",
  "acceptance": ["A1", "A2"],
  "pins": {"rows.py:40": "def load(path):", "rows.py:41": "return parse(path)"},
  "parts": [{"name": "totals", "acceptance": "A1"}, {"name": "format", "acceptance": "A2"}],
  "slices": [
    {
      "id": "S1",
      "files": ["report.py"],
      "small": true,
      "depends": [],
      "parallel": [],
      "inputs": [{"field": "rows", "source": "rows.py:40"}],
      "outputs": ["report"],
      "effects": {"reads": ["rows.csv"], "writes": ["out/report.json"]},
      "calls": ["open", "json.dump"],
      "interface": ["report.render"],
      "scenarios": ["SC1"],
      "claims": [
        {"id": "C1.1", "strength": "tested", "evidence": "tests/test_report.py:12", "lines": [1]},
        {"id": "C1.2", "strength": "proved", "evidence": "report.py:21", "technique": "induction", "lines": [2]}
      ],
      "pseudocode": [
        {"line": 1, "text": "valid = filter(rows, is_valid)", "done": "report.py:20"},
        {"line": 2, "text": "for row in valid: total += row.amount", "measure": "len(valid) - i", "done": "report.py:21"}
      ]
    }
  ],
  "composition": [
    {"id": "K0", "statement": "Current system satisfies Pre(S1)", "justification": "rows.py:40"},
    {"id": "Kinv", "statement": "Invariant holds after S1", "justification": "rows.py:41"},
    {"id": "Kg", "statement": "Post(S1) gives the Goal", "justification": "C1.2", "uses": ["C1.2"]}
  ],
  "accepted": []
}
```

| Field | Meaning |
|---|---|
| `inputs[].source` | `S#.<output>` from a slice in `depends`, or a `file:line` in the current system |
| `effects` | Reads and writes of the slice (`pure-slice`). `confluence` compares them for parallel slices. |
| `calls` | Effect calls the slice is allowed to make, for example `open` or `requests.get` |
| `interface` | Public symbols the slice may add, change, or remove. See "Interface items". |
| `pins` | Object. Key: a `file:line` reference. Value: that line, with surrounding spaces removed. `verify_plan.py --pin` writes it. |
| `slices[].small` | `true` applies the small-slice rule of `proof.md` |
| `claims[].strength` | `proved`, `tested`, or `assumed` |
| `claims[].technique` | `case`, `induction`, `contradiction`, or `chaining`. A `proved` claim needs one. |
| `claims[].lines` | Numbers of the pseudocode lines the claim covers. An `assumed` claim needs none. |
| `claims[].cases` | For `case`: a list of `{"name", "test"}`. `test` is an exact test name. |
| `pseudocode[].measure` | The measure of a loop line: the value that shrinks each round |
| `composition[].uses` | IDs of the claims the link relies on |
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

## Reference pins

`verify_plan.py` checks each `file:line` in `source` and `justification`, and in `evidence` and `done` from Phase 2. A pytest node ID or a URL is not a reference.
`--pin` adds a pin for each unpinned reference that resolves. It moves a reference when the pinned text is on exactly one other line.
It prints each `new` pin and each `moved` reference: the pin report. It never changes a pin value.

| ID | Meaning |
|---|---|
| `unpinned:rows.py:40` | The reference has no pin. `--pin` repairs it. |
| `moved:rows.py:40` | The pinned text is on one other line. `--pin` repairs it. |
| `drift:rows.py:40` | The pinned text is not in the file, or is on more than one other line. `--pin` does not repair it. |

A reference that `ref:` reports has no pin finding.
A pin shows that a line did not change. It does not show that the line supports the claim.

## Proof checks

Each ID is a `fail`.

| ID | Phase | Meaning |
|---|---|---|
| `technique:C1.1` | 1 | A `proved` claim has no `technique`, or an unknown one |
| `claim-lines:C1.1` | 1 | `lines` is empty, or names a line the slice pseudocode does not have. An `assumed` claim needs none. |
| `cases:C1.1` | 1 | `technique` is `case` and `cases` is empty |
| `measure:S1.line2` | 1 | A loop line has no `measure`. A loop line starts with `for`, `while`, `loop`, `repeat`, or `recurse`. |
| `composition-missing:K1` | 1 | With n slices, rows `K0` to `K<n-1>`, `Kinv`, and `Kg` must exist |
| `uses:K1-C9.9` | 1 | `uses` names a claim that does not exist |
| `strength-low:C1.1` | 1 | A row uses a `tested` claim. A claim of a `small` slice is exempt. |
| `case-test:C1.1.empty` | 2 | A case names no test, or no test has that name |
| `claim-test:C1.1` | 2 | A `tested` claim, and no test name contains `c1_1` (any case, not followed by a digit) |
| `small:S1` | 2 | `ast_checks.py`. A `small` slice adds more than 20 lines outside its test files. |

## Diagram and property checks

`plan_dot.py PLAN --check FILE` prints findings as JSON. `--write FILE` makes a skeleton and never overwrites a file.

| ID | Level | Meaning |
|---|---|---|
| `diagram:node:S2` | `fail` | Slice S2 is not a node of the diagram |
| `diagram:edge:S1-S2` | `fail` | S2 depends on S1, and the diagram has no edge `S1 -> S2` |
| `diagram:extra:S1-S3` | `fail` | The diagram joins two slice nodes, and the plan has no such `depends` |
| `diagram:unknown:S9` | `fail` | A node name looks like a slice ID, and the plan has no such slice |
| `diagram:exists` | `fail` | `--write` found the file. It does not overwrite. |
| `diagram:dot` | `not-run` | `dot` is absent, or cannot read the file |

`prop_checks.py PLAN` covers each `tested` claim that has no `cases`. It runs in Phase 2 and Phase 3.

| ID | Level | Meaning |
|---|---|---|
| `property:C1.1` | `fail` | The project names Hypothesis or fast-check, and no test of the claim is a property test |
| `property-seed:C1.1` | `fail` | The property test has no fixed seed |
| `property:library:py`, `property:library:js` | `consider` | A claim is in scope, and the project does not name the library |
| `property:unread:tests/test_a.py` | `not-run` | The script cannot parse this test file |

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
