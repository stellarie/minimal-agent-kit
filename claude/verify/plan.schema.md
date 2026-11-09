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
| `interface` | Public symbols the slice may add, change, or remove |
| `claims[].strength` | `proved`, `tested`, or `assumed` |
| `pseudocode[].done` | The code `file:line` of the line. Empty in Phase 1. |
| `accepted` | Finding IDs the human accepted |

Paths are relative to the project root.

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
