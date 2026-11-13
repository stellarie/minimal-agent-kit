"""Check the structure of a plan file and merge findings from other checks.

Usage: python verify_plan.py PLAN [--root DIR] [--phase 1|2|3] [--findings FILE ...]
Exit 1 when a finding has level "fail" and its ID is not in "accepted".
The format is in plan.schema.md.
Checks: schema types, references, input sources, parts without acceptance items and the reverse,
link justifications, claim strength, confluence, and the slice graph:
dependency loops, unknown `depends`, duplicate IDs, one file in two slices, parallel slices that depend
on each other or list each other on one side only, slice order, and outputs that no slice reads.
Phase 2 adds `done` locations, scenario tests, and claim evidence: a `tested` claim cites a test file,
a `proved` claim cites something. Last, "accepted" IDs that match no finding are noted as stale.
"""

import argparse
import json
import pathlib
import posixpath
import re
import sys

STRENGTHS = {"proved", "tested", "assumed"}
REF = re.compile(r"^(?P<file>(?:[A-Za-z]:)?[^:\s]+):(?P<line>\d+)$")
REFS = re.compile(r"(?<![\w/])(?:[A-Za-z]:[\\/])?[^\s,;():]+:\d+")
URL = re.compile(r"\w+://\S+")
TEST_FILE = re.compile(r"(^test_.*\.py$|_test\.py$|\.(test|spec)\.[cm]?[jt]sx?$)")
GO_TEST = re.compile(r"_test\.go$")
NODE_REF = re.compile(r"(?<![\w/])((?:[A-Za-z]:[\\/])?[^\s,;():`'\"\[]+\.\w+)(?:::\w+)+(?:\[(?:[^\[\]]|\[[^\]]*\])*\])?")
TEST_DIRS = {"tests", "test", "__tests__"}
SLICE_SOURCE = re.compile(r"^(S\d+)\.(\w+)$")
SKIP_DIRS = {"node_modules", ".git", ".venv", "venv", "dist", "build", "site-packages", "__pycache__"}
TEXT_FIELDS = {
    "parts": ["acceptance"], "composition": ["justification", "statement"], "inputs": ["source"],
    "claims": ["evidence", "strength"], "pseudocode": ["done", "text"],
}
LIST_FIELDS = {"slices": ["scenarios", "depends", "parallel", "files", "calls", "interface", "outputs"]}
REQUIRED = {"slices": ["id"], "claims": ["id"], "inputs": ["field"], "pseudocode": ["line"], "composition": ["id"], "parts": ["name"]}


def finding(fid, check, detail, file="", line=0, level="fail"):
    return {"id": fid, "check": check, "level": level, "file": file, "line": line, "detail": detail}


def ref_error(root, ref):
    m = REF.match(ref)
    if not m:
        return None
    path = root / m["file"]
    if not path.is_file():
        return f"{m['file']} does not exist"
    lines = len(path.read_text(encoding="utf-8", errors="replace").splitlines())
    if not 1 <= int(m["line"]) <= lines:
        return f"{ref} is outside the file ({lines} lines)"
    return None


def check_keys(plan, root):
    if not isinstance(plan, dict):
        return [finding("schema:top", "schema", "the plan must be a JSON object")]
    out = []
    queue = []
    for key in ("acceptance", "accepted"):
        value = plan.get(key, [])
        if not isinstance(value, list) or not all(isinstance(v, str) for v in value):
            out.append(finding(f"schema:{key}", "schema", f"{key!r} must be a list of text"))
    for key in ("parts", "composition", "slices"):
        if not isinstance(plan.get(key, []), list):
            out.append(finding(f"schema:{key}", "schema", f"{key!r} must be a list"))
        elif key in REQUIRED:
            queue.append((key, plan.get(key, [])))
    while queue:
        kind, items = queue.pop(0)
        for n, item in enumerate(items):
            if not isinstance(item, dict):
                out.append(finding(f"schema:{kind}[{n}]", "schema", f"{kind} entry {n} must be an object"))
                continue
            for key in REQUIRED[kind]:
                value = item.get(key)
                if isinstance(value, bool) or not isinstance(value, (str, int)):
                    out.append(finding(f"schema:{kind}[{n}].{key}", "schema", f"{kind} entry {n} has no {key!r}"))
            for key in TEXT_FIELDS.get(kind, ()):
                if not isinstance(item.get(key, ""), str):
                    out.append(finding(f"schema:{kind}[{n}].{key}", "schema", f"{key!r} must be text"))
            for key in LIST_FIELDS.get(kind, ()):
                value = item.get(key, [])
                if not isinstance(value, list) or not all(isinstance(v, str) for v in value):
                    out.append(finding(f"schema:{kind}[{n}].{key}", "schema", f"{key!r} must be a list of text"))
            if kind == "slices":
                effects = item.get("effects", {})
                ok = isinstance(effects, dict) and all(
                    isinstance(effects.get(k, []), list) and all(isinstance(v, str) for v in effects.get(k, []))
                    for k in ("reads", "writes")
                )
                if not ok:
                    out.append(finding(f"schema:slices[{n}].effects", "schema", "'effects' must be an object with lists of text in 'reads' and 'writes'"))
                for sub in ("claims", "inputs", "pseudocode"):
                    if isinstance(item.get(sub, []), list):
                        queue.append((sub, item.get(sub, [])))
                    else:
                        out.append(finding(f"schema:slices[{n}].{sub}", "schema", f"{sub!r} must be a list"))
    return out


def load_json(path):
    data = path.read_bytes()
    text = data.decode("utf-16") if data[:2] in (b"\xff\xfe", b"\xfe\xff") else data.decode("utf-8-sig")
    return json.loads(text)


def refs_in(plan, phase):
    """Return (owner, text, is_evidence) for each field that holds references."""
    refs = [(k["id"], k.get("justification", ""), False) for k in plan.get("composition", [])]
    for s in plan.get("slices", []):
        refs += [(f"{s['id']}.{i['field']}", i.get("source", ""), False) for i in s.get("inputs", [])]
        if phase >= 2:
            refs += [(c["id"], c.get("evidence", ""), True) for c in s.get("claims", [])]
            refs += [(f"{s['id']}.line{p['line']}", p.get("done", ""), False) for p in s.get("pseudocode", [])]
    return refs


def check_refs(plan, root, phase=1):
    out = []
    for owner, text, is_evidence in refs_in(plan, phase):
        text = URL.sub(" ", text or "")
        for node in NODE_REF.finditer(text) if is_evidence else ():
            if not (root / node[1]).is_file():
                out.append(finding(f"ref:{owner}:{node[0]}", "ref", f"{node[1]} does not exist", node[1]))
        for ref in REFS.findall(NODE_REF.sub(" ", text)):
            err = ref_error(root, ref)
            if err:
                file, line = ref.rsplit(":", 1)
                out.append(finding(f"ref:{owner}:{ref}", "ref", err, file, int(line)))
    return out


def check_sources(plan, root):
    out = []
    slices = {str(s["id"]): s for s in plan.get("slices", [])}
    for s in plan.get("slices", []):
        for i in s.get("inputs", []):
            src = i.get("source", "")
            fid = f"source:{s['id']}.{i['field']}"
            m = SLICE_SOURCE.match(src)
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
            elif c["strength"] == "assumed" and str(c["id"]) not in plan.get("accepted", []):
                out.append(finding(f"assumed:{c['id']}", "strength", "assumed claim is not accepted"))
    return out


def touched(s):
    e = s.get("effects", {})
    return set(s.get("files", [])) | set(e.get("writes", [])), set(e.get("reads", []))


def check_confluence(plan, root):
    out = []
    slices = {str(s["id"]): s for s in plan.get("slices", [])}
    seen = set()
    for s in plan.get("slices", []):
        for other in s.get("parallel", []):
            pair = tuple(sorted((str(s["id"]), other)))
            if other not in slices:
                out.append(finding(f"confluence:{s['id']}-{other}", "confluence", f"parallel slice {other} does not exist"))
                continue
            if pair in seen:
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


TEST_NAME = re.compile(
    r"(?:def\s+(test\w*)|class\s+Test_?(\w+)"
    r"|\b(?:test|it|describe)(?:\.\w+)*(?:\([^()]*\))?\(\s*[\"'`]([^\"'`]*))"
)


def test_names(root):
    names = []
    for path in root.rglob("*"):
        parts = path.relative_to(root).parts
        if SKIP_DIRS & set(parts) or not TEST_FILE.search(path.name):
            continue
        text = path.read_text(encoding="utf-8", errors="replace")
        names += [a or b or c for a, b, c in TEST_NAME.findall(text)]
    return names


def check_scenarios(plan, root):
    names = test_names(root)
    out = []
    for s in plan.get("slices", []):
        for sc in s.get("scenarios", []):
            pattern = re.compile(r"(?<![A-Za-z0-9])" + re.escape(sc) + r"(?![A-Za-z0-9])", re.I)
            if not any(pattern.search(n) for n in names):
                out.append(finding(f"scenario:{sc}", "scenario", "no test name contains this scenario ID"))
    return out


def link_graph(plan, key):
    """Map each slice ID to the IDs in its `key` list. Slices with one ID merge."""
    graph = {}
    for s in plan.get("slices", []):
        graph.setdefault(str(s["id"]), set()).update(s.get(key, []))
    return graph


def reach(graph):
    out = {}
    for start in graph:
        seen, stack = set(), [start]
        while stack:
            for nxt in graph.get(stack.pop(), ()):
                if nxt not in seen:
                    seen.add(nxt)
                    stack.append(nxt)
        out[start] = seen
    return out


def loops(graph):
    """Return each loop of the graph once, as a sorted tuple of its members."""
    far = reach(graph)
    found = set()
    for node in graph:
        if node in far[node]:
            found.add(tuple(sorted({node} | {m for m in far[node] if node in far.get(m, ())})))
    return sorted(found)


def check_cycles(plan, root):
    return [
        finding("cycle:" + "-".join(members), "signature", "slices depend on each other: " + ", ".join(members))
        for members in loops(link_graph(plan, "depends"))
    ]


def check_unknown_depends(plan, root):
    graph = link_graph(plan, "depends")
    return [
        finding(f"depends:{sid}-{dep}", "signature", f"{sid} depends on {dep}, which is not a slice")
        for sid in graph
        for dep in sorted(graph[sid] - graph.keys())
    ]


def check_duplicates(plan, root):
    slices = plan.get("slices", [])
    out = []
    for kind, ids in (("slice", [str(s["id"]) for s in slices]), ("claim", [str(c["id"]) for s in slices for c in s.get("claims", [])])):
        for dup in sorted({i for i in ids if ids.count(i) > 1}):
            out.append(finding(f"duplicate:{kind}:{dup}", "signature", f"{kind} ID {dup} is used more than once"))
    return out


def unique(findings):
    return list({f["id"]: f for f in findings}.values())


def norm_path(path):
    return posixpath.normpath(path.replace("\\", "/"))


def check_owners(plan, root):
    owners = {}
    for s in plan.get("slices", []):
        for f in {norm_path(f) for f in s.get("files", []) if f.strip()}:
            owners.setdefault(f, []).append(str(s["id"]))
    return [
        finding(f"owner:{f}", "confluence", f"{f} is in slices " + ", ".join(ids))
        for f, ids in sorted(owners.items())
        if len(ids) > 1
    ]


def check_parallel_depends(plan, root):
    far = reach(link_graph(plan, "depends"))
    pairs = {
        tuple(sorted((a, b)))
        for a, others in link_graph(plan, "parallel").items()
        for b in others
        if a != b and b in far and (b in far[a] or a in far[b])
    }
    return [
        finding(f"parallel-depends:{a}-{b}", "confluence", f"parallel slices {a} and {b}: one depends on the other")
        for a, b in sorted(pairs)
    ]


def check_parallel_pair(plan, root):
    graph = link_graph(plan, "parallel")
    pairs = {tuple(sorted((a, b))) for a, others in graph.items() for b in others if b in graph and a not in graph[b]}
    return [
        finding(f"parallel-pair:{a}-{b}", "confluence", f"only one of {a} and {b} lists the other in parallel")
        for a, b in sorted(pairs)
    ]


def check_order(plan, root):
    far = reach(link_graph(plan, "depends"))
    first = {}
    for n, s in enumerate(plan.get("slices", [])):
        first.setdefault(str(s["id"]), n)
    out = []
    for sid, deps in link_graph(plan, "depends").items():
        late = sorted(d for d in deps if d in first and first[d] > first[sid])
        if late and sid not in far[sid]:
            out.append(finding(f"order:{sid}", "signature", f"{sid} is listed before " + ", ".join(late) + ", which it depends on"))
    return out


def check_unused(plan, root):
    used = {
        (m[1], m[2])
        for s in plan.get("slices", [])
        for i in s.get("inputs", [])
        if (m := SLICE_SOURCE.match(i.get("source", ""))) and m[1] != str(s["id"])
    }
    return unique([
        finding(f"unused:{s['id']}.{o}", "signature", f"no other slice reads output {o} of {s['id']}", level="consider")
        for s in plan.get("slices", [])
        for o in s.get("outputs", [])
        if (str(s["id"]), o) not in used
    ])


def check_uncovered(plan, root):
    parts = plan.get("parts", [])
    covered = {p.get("acceptance") for p in parts}
    return unique([
        finding(f"uncovered:{item}", "lazy", "no part names this acceptance item")
        for item in plan.get("acceptance", [])
        if parts and item not in covered
    ])


def is_test_path(file):
    path = pathlib.PurePosixPath(file.replace("\\", "/"))
    return bool(TEST_FILE.search(path.name) or GO_TEST.search(path.name) or TEST_DIRS & set(path.parts[:-1]))


def evidence_files(text):
    """Files named by `file:line` refs and by pytest node IDs (`file::name`)."""
    text = URL.sub(" ", text)
    return [r.rsplit(":", 1)[0] for r in REFS.findall(NODE_REF.sub(" ", text))] + [m[1] for m in NODE_REF.finditer(text)]


def check_evidence(plan, root):
    out = []
    for s in plan.get("slices", []):
        for c in s.get("claims", []):
            text = c.get("evidence", "")
            if c.get("strength") == "tested":
                bad = not any(is_test_path(f) for f in evidence_files(text))
                why = "tested claim has no evidence in a test file"
            else:
                bad = c.get("strength") == "proved" and not text.strip()
                why = "proved claim has no evidence"
            if bad:
                out.append(finding(f"evidence:{c['id']}", "strength", why))
    return unique(out)


def check_stale(plan, found):
    seen = {f["id"] for f in found} | {str(c["id"]) for s in plan.get("slices", []) for c in s.get("claims", [])}
    return [
        finding(f"stale:{a}", "accepted", "accepted ID matches no finding of this run", level="consider")
        for a in dict.fromkeys(plan.get("accepted", []))
        if a not in seen
    ]


RULES = {
    1: [
        check_keys, check_refs, check_sources, check_lazy, check_composition, check_strength, check_confluence,
        check_cycles, check_unknown_depends, check_duplicates, check_owners, check_parallel_depends,
        check_parallel_pair, check_order, check_unused, check_uncovered,
    ],
    2: [check_done, check_scenarios, check_evidence],
}


def verify(plan, root, phase, extra=()):
    found = check_keys(plan, root)
    if found:
        return found, found
    for level in sorted(RULES):
        if level <= phase:
            for rule in RULES[level]:
                if rule is check_keys:
                    continue
                found += rule(plan, root, phase) if rule is check_refs else rule(plan, root)
    found += list(extra)
    found += check_stale(plan, found)
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
    plan = load_json(args.plan)
    extra = [f for path in args.findings for f in load_json(path)]
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
