"""Write a design diagram skeleton from the slice graph, or check a diagram against it.

Usage: python plan_dot.py PLAN --write design.dot
       python plan_dot.py PLAN --check design.dot [--root DIR]
`--write` makes one node for each slice and one edge `dep -> slice` for each `depends` entry, under the
header of diagram.md. It never overwrites a file. `--check` runs `dot -Tjson0` and prints findings as JSON
(format in plan.schema.md). Exit 1 when a finding has level "fail".
A slice node is a node whose name is a slice ID. All other nodes, clusters, and edges are free.
Checks: a slice with no node (`diagram:node:`), a `depends` with no edge (`diagram:edge:`), an edge
between slice nodes with no `depends` (`diagram:extra:`), a node named like a slice that the plan does not
have (`diagram:unknown:`). `diagram:dot` (level `not-run`) means `dot` is absent or cannot read the file.
"""

import argparse
import json
import pathlib
import re
import shutil
import subprocess
import sys

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import verify_plan  # noqa: E402

SLICE_ID = re.compile(r"^S\d+$")
# Header from core/skills/workflow/diagram.md. Do not change the colors.
HEADER = """digraph design {
  rankdir=LR; bgcolor="#0F172A"; pad=0.4; nodesep=0.5; ranksep=0.9;
  fontname="DejaVu Sans"; fontsize=13; fontcolor="#CBD5E1";
  node [shape=box, style="rounded,filled", fillcolor="#1E293B", color="#38BDF8",
        penwidth=1.4, fontname="DejaVu Sans", fontsize=12, fontcolor="#E2E8F0",
        margin="0.25,0.12"];
  edge [color="#64748B", penwidth=1.3, arrowsize=0.7, fontname="DejaVu Sans",
        fontsize=10, fontcolor="#94A3B8"];
"""


def finding(fid, check, detail, file="", line=0, level="fail"):
    return {"id": fid, "check": check, "level": level, "file": file, "line": line, "detail": detail}


def plan_edges(plan):
    """Return the set of (dep, slice) pairs from the `depends` fields."""
    return {(str(d), str(s["id"])) for s in plan.get("slices", []) for d in s.get("depends", [])}


def skeleton(plan):
    lines = [f"  {json.dumps(str(s['id']))};\n" for s in plan.get("slices", [])]
    lines += [f"  {json.dumps(a)} -> {json.dumps(b)};\n" for a, b in sorted(plan_edges(plan))]
    return HEADER + "".join(lines) + "}\n"


def read_diagram(path):
    """Return (names, edges) from `dot -Tjson0`, or a not-run finding."""
    dot = shutil.which("dot")
    if not dot:
        return None, finding("diagram:dot", "diagram", "dot is not on PATH", str(path), level="not-run")
    r = subprocess.run([dot, "-Tjson0", str(path)], capture_output=True, text=True, encoding="utf-8")
    try:
        data = json.loads(r.stdout)
    except json.JSONDecodeError:
        err = (r.stderr or "no output").strip()[:200]
        return None, finding("diagram:dot", "diagram", f"dot cannot read the file: {err}", str(path), level="not-run")
    # An object with a `nodes` key is a cluster. Any other object is a node.
    names = {o["_gvid"]: o["name"] for o in data.get("objects", []) if "nodes" not in o}
    edges = {(names[e["tail"]], names[e["head"]]) for e in data.get("edges", []) if e["tail"] in names and e["head"] in names}
    return (set(names.values()), edges), None


def check(plan, path):
    got, problem = read_diagram(path)
    if problem:
        return [problem]
    names, edges = got
    ids = {str(s["id"]) for s in plan.get("slices", [])}
    out = [finding(f"diagram:node:{i}", "diagram", f"slice {i} is not a node of the diagram", str(path)) for i in sorted(ids - names)]
    for a, b in sorted(plan_edges(plan) - edges):
        out.append(finding(f"diagram:edge:{a}-{b}", "diagram", f"{b} depends on {a}, the diagram has no edge {a} -> {b}", str(path)))
    for a, b in sorted(e for e in edges if e[0] in ids and e[1] in ids and e not in plan_edges(plan)):
        out.append(finding(f"diagram:extra:{a}-{b}", "diagram", f"edge {a} -> {b} has no depends in the plan", str(path)))
    for n in sorted(n for n in names - ids if SLICE_ID.match(n)):
        out.append(finding(f"diagram:unknown:{n}", "diagram", f"node {n} looks like a slice ID, the plan has no such slice", str(path)))
    return out


def main(argv):
    parser = argparse.ArgumentParser()
    parser.add_argument("plan", type=pathlib.Path)
    parser.add_argument("--root", type=pathlib.Path, default=pathlib.Path("."))
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--write", type=pathlib.Path, metavar="DOT")
    mode.add_argument("--check", type=pathlib.Path, metavar="DOT")
    args = parser.parse_args(argv)
    plan = verify_plan.load_json(args.plan)
    found = verify_plan.check_keys(plan, args.root)
    if not found and args.write:
        try:
            with open(args.write, "x", encoding="utf-8") as f:
                f.write(skeleton(plan))
        except FileExistsError:
            found = [finding("diagram:exists", "diagram", "file exists, --write does not overwrite", str(args.write))]
    elif not found:
        found = check(plan, args.check)
    print(json.dumps(found, indent=1))
    return 1 if any(f["level"] == "fail" for f in found) else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
