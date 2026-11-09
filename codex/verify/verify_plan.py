"""Check the structure of a plan file and merge findings from other checks.

Usage: python verify_plan.py PLAN [--root DIR] [--phase 1|2|3] [--findings FILE ...]
Exit 1 when a finding has level "fail" and its ID is not in "accepted".
The format is in plan.schema.md.
"""

import argparse
import json
import pathlib
import re
import sys

STRENGTHS = {"proved", "tested", "assumed"}
REF = re.compile(r"^(?P<file>[^:\s]+):(?P<line>\d+)$")
TEST_FILE = re.compile(r"(^test_.*\.py$|_test\.py$|\.(test|spec)\.[cm]?[jt]sx?$)")


def finding(fid, check, detail, file="", line=0, level="fail"):
    return {"id": fid, "check": check, "level": level, "file": file, "line": line, "detail": detail}


def ref_error(root, ref):
    m = REF.match(ref)
    if not m:
        return None
    path = root / m["file"]
    if not path.is_file():
        return f"{m['file']} does not exist"
    lines = path.read_text(encoding="utf-8", errors="replace").count("\n") + 1
    if int(m["line"]) > lines:
        return f"{ref} is past the end of the file ({lines} lines)"
    return None


def check_refs(plan, root):
    out = []
    refs = [(k["id"], k.get("justification", "")) for k in plan.get("composition", [])]
    for s in plan.get("slices", []):
        refs += [(f"{s['id']}.{i['field']}", i.get("source", "")) for i in s.get("inputs", [])]
        refs += [(c["id"], c.get("evidence", "")) for c in s.get("claims", [])]
        refs += [(f"{s['id']}.line{p['line']}", p.get("done", "")) for p in s.get("pseudocode", [])]
    for owner, text in refs:
        for ref in re.findall(r"[^\s,;()]+:\d+", text or ""):
            err = ref_error(root, ref)
            if err:
                file, line = ref.rsplit(":", 1)
                out.append(finding(f"ref:{owner}:{ref}", "ref", err, file, int(line)))
    return out


def check_sources(plan, root):
    out = []
    slices = {s["id"]: s for s in plan.get("slices", [])}
    for s in plan.get("slices", []):
        for i in s.get("inputs", []):
            src = i.get("source", "")
            fid = f"source:{s['id']}.{i['field']}"
            m = re.match(r"^(S\d+)\.(\w+)$", src)
            if m:
                dep = slices.get(m[1])
                if m[1] not in s.get("depends", []):
                    out.append(finding(fid, "signature", f"source {m[1]} is not in depends"))
                elif dep is None or m[2] not in dep.get("outputs", []):
                    out.append(finding(fid, "signature", f"{src} is not an output of {m[1]}"))
            elif not REF.match(src):
                out.append(finding(fid, "signature", "input has no source"))
    return out


def check_lazy(plan, root):
    items = set(plan.get("acceptance", []))
    return [
        finding(f"lazy:{p['name']}", "lazy", "part names no acceptance item")
        for p in plan.get("parts", [])
        if p.get("acceptance") not in items
    ]


def check_composition(plan, root):
    return [
        finding(f"composition:{k['id']}", "composition", "link has no justification")
        for k in plan.get("composition", [])
        if not k.get("justification", "").strip()
    ]


def check_strength(plan, root):
    out = []
    for s in plan.get("slices", []):
        for c in s.get("claims", []):
            if c.get("strength") not in STRENGTHS:
                out.append(finding(f"strength:{c['id']}", "strength", f"strength is {c.get('strength')!r}"))
            elif c["strength"] == "assumed" and c["id"] not in plan.get("accepted", []):
                out.append(finding(f"assumed:{c['id']}", "strength", "assumed claim is not accepted"))
    return out


def touched(s):
    e = s.get("effects", {})
    return set(s.get("files", [])) | set(e.get("writes", [])), set(e.get("reads", []))


def check_confluence(plan, root):
    out = []
    slices = {s["id"]: s for s in plan.get("slices", [])}
    seen = set()
    for s in plan.get("slices", []):
        for other in s.get("parallel", []):
            pair = tuple(sorted((s["id"], other)))
            if pair in seen or other not in slices:
                continue
            seen.add(pair)
            (wa, ra), (wb, rb) = touched(s), touched(slices[other])
            overlap = (wa & (wb | rb)) | (wb & ra)
            if overlap:
                detail = "parallel slices share " + ", ".join(sorted(overlap))
                out.append(finding(f"confluence:{pair[0]}-{pair[1]}", "confluence", detail))
    return out


def check_done(plan, root):
    return [
        finding(f"done:{s['id']}.line{p['line']}", "reduction", "pseudocode line has no done location")
        for s in plan.get("slices", [])
        for p in s.get("pseudocode", [])
        if not REF.match(p.get("done", ""))
    ]


def check_scenarios(plan, root):
    text = ""
    for path in root.rglob("*"):
        parts = path.relative_to(root).parts
        if "node_modules" in parts or ".git" in parts or not TEST_FILE.search(path.name):
            continue
        text += path.read_text(encoding="utf-8", errors="replace")
    return [
        finding(f"scenario:{sc}", "scenario", "no test file names this scenario")
        for s in plan.get("slices", [])
        for sc in s.get("scenarios", [])
        if sc not in text
    ]


RULES = {
    1: [check_refs, check_sources, check_lazy, check_composition, check_strength, check_confluence],
    2: [check_done, check_scenarios],
}


def verify(plan, root, phase, extra=()):
    found = []
    for level in sorted(RULES):
        if level <= phase:
            for rule in RULES[level]:
                found += rule(plan, root)
    found += list(extra)
    accepted = set(plan.get("accepted", []))
    blocking = [f for f in found if f["level"] == "fail" and f["id"] not in accepted]
    return found, blocking


def main(argv):
    parser = argparse.ArgumentParser()
    parser.add_argument("plan", type=pathlib.Path)
    parser.add_argument("--root", type=pathlib.Path, default=pathlib.Path("."))
    parser.add_argument("--phase", type=int, choices=(1, 2, 3), default=1)
    parser.add_argument("--findings", type=pathlib.Path, nargs="*", default=[])
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args(argv)
    plan = json.loads(args.plan.read_text(encoding="utf-8"))
    extra = [f for path in args.findings for f in json.loads(path.read_text(encoding="utf-8"))]
    found, blocking = verify(plan, args.root.resolve(), args.phase, extra)
    if args.json:
        print(json.dumps(found, indent=1))
    else:
        accepted = set(plan.get("accepted", []))
        for f in found:
            mark = "accepted" if f["id"] in accepted else f["level"]
            where = f"{f['file']}:{f['line']}  " if f["file"] else ""
            print(f"{mark:9} {f['id']}  {where}{f['detail']}")
        print(f"{len(found)} finding(s), {len(blocking)} blocking")
    return 1 if blocking else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
