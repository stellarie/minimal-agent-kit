"""Compare the plan with the changed code, from syntax facts.

Usage: python ast_checks.py PLAN --base REV [--root DIR] [--phase 1|2|3] [FILE ...]
Prints findings as JSON (format in plan.schema.md). Exit 1 when a finding has level "fail".
Checks: files outside every slice, eta, effect calls not in the slice, imports from a slice not in
`depends`, functions and module-level code without a
pseudocode `done` location (phase 2 and later), and public interface changes not in the slice.
"""

import argparse
import json
import pathlib
import posixpath
import re
import shutil
import subprocess
import sys

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import verify_plan  # noqa: E402
PY = {".py"}
JS = {".js", ".mjs", ".cjs", ".jsx"}
EFFECTS = re.compile(
    r"^(open|print|input|exec|eval|fetch|require)$"
    r"|^os\.(remove|unlink|rmdir|removedirs|rename|replace|system|popen|mkdir|makedirs|chmod|chown|kill|putenv|listdir|scandir|walk|stat)$"
    r"|^os\.path\.(exists|isfile|isdir|getsize|getmtime)$"
    r"|^(shutil|subprocess|requests|httpx|urllib|socket|random|logging|sqlite3|fs|http|https"
    r"|child_process|axios|localStorage|sessionStorage|console)\."
    r"|^(os\.environ|os\.getenv|process\.env|process\.exit|time\.time|time\.sleep|Math\.random|Date\.now)"
    r"|^(json\.dump|pickle\.dump)$"
    r"|\.(write_text|write_bytes|writeFile|writeFileSync|appendFile|appendFileSync|unlink|unlinkSync|rmdir|mkdir|rmSync)$"
)
# Method names that often mean an effect, but also name pure methods such as list.remove.
# A hit is reported at level "consider" and never blocks.
MAYBE = re.compile(r"\.(write|send|query|execute|executemany|commit|remove|post|put|delete|insert|update|emit)$")
TRIVIAL = re.compile(r"^\s*(#|//|/\*|\*|[\]\)\};,]*\s*$)")
HUNK = re.compile(r"^@@ -\S+ \+(\d+)(?:,(\d+))? @@", re.M)


def finding(fid, check, detail, file="", line=0, level="fail"):
    return {"id": fid, "check": check, "level": level, "file": file, "line": line, "detail": detail}


def git(root, *args):
    return subprocess.run(["git", "-C", str(root), *args], capture_output=True, text=True, encoding="utf-8")


def changed_files(root, base):
    tracked = git(root, "diff", "--name-only", "--relative", "-z", base).stdout.split("\0")
    new = git(root, "ls-files", "--others", "--exclude-standard", "-z").stdout.split("\0")
    return sorted((set(tracked) | set(new)) - {""})


def base_source(root, base, rel):
    r = git(root, "show", f"{base}:./{rel}")
    return r.stdout if r.returncode == 0 else None


def changed_lines(root, base, rel, base_src, head_src):
    if base_src is None:
        return set(range(1, head_src.count("\n") + 2))
    out = set()
    diff = git(root, "diff", "-U0", "--no-color", "--no-ext-diff", "--no-textconv", base, "--", rel).stdout
    for m in HUNK.finditer(diff):
        start, count = int(m[1]), int(m[2] if m[2] is not None else 1)
        out.update(range(start, start + count))
    return out


def extract(path_suffix, source):
    if source is None:
        return {"functions": [], "calls": [], "interface": []}
    if path_suffix in PY:
        cmd = [sys.executable, str(HERE / "facts_py.py")]
    else:
        node = shutil.which("node")
        if not node:
            return {"error": "node is not on PATH"}
        cmd = [node, str(HERE / "facts_js.mjs")]
    r = subprocess.run(cmd, input=source, capture_output=True, text=True, encoding="utf-8")
    try:
        return json.loads(r.stdout)
    except json.JSONDecodeError:
        return {"error": (r.stderr or "no output").strip()[:200]}


def allowed(name, entries):
    return any(name == e or name.startswith(e + ".") or name.endswith("." + e) for e in entries)


def planned(item, entries):
    """Route, props, and export items must match an entry exactly. Python items match by symbol name."""
    kind = item.split(" ", 1)[0]
    if kind == "props":
        return any(e.split("{")[0] == item.split("{")[0] for e in entries)
    if kind in ("route", "export"):
        return item in entries
    words = re.findall(r"[A-Za-z_$][\w$]*", item.split("(")[0])
    name = words[-1] if words else item
    return name in {e.split(".")[-1] for e in entries}


def resolve(rel, imp, files):
    """Return the files in `files` that an import names. Each name in the import counts."""
    here = pathlib.PurePosixPath(rel).parent
    py = pathlib.PurePosixPath(rel).suffix in PY
    out = set()
    for spec in imp["specs"]:
        parts = [p for p in spec.split(".") if p]
        if py and imp["level"]:
            base = here
            for _ in range(imp["level"] - 1):
                base = base.parent
            bases = [base]
        elif py:
            # The plan root, then each folder from the importing file up (src layouts, sibling scripts).
            bases = [pathlib.PurePosixPath("")] + [here, *here.parents][:-1] if parts else []
        elif spec.startswith("."):
            stem = posixpath.normpath(f"{here}/{spec}")
            out.update(t for t in [stem] + [stem + e for e in sorted(JS)] + [f"{stem}/index{e}" for e in sorted(JS)] if t in files)
            continue
        else:
            continue
        for base in bases:
            hits = py_targets(base, parts, files, relative=bool(imp["level"]))
            if hits:
                out.update(hits)
                break
    return out


def py_targets(base, parts, files, relative):
    """Files an import runs: each package `__init__.py` on the way, then the module. A package wins over a module."""
    def norm(p):
        return posixpath.normpath(str(p))
    hits = []
    for i in range(1, len(parts)):
        init = norm(base.joinpath(*parts[:i], "__init__.py"))
        if init in files:
            hits.append(init)
    full = base.joinpath(*parts)
    for t in (norm(full / "__init__.py"), norm(f"{full}.py")):
        if t in files:
            hits.append(t)
            break
    if relative and not parts and norm(base / "__init__.py") in files:
        hits.append(norm(base / "__init__.py"))
    return hits


def check_depends(plan, rel, owner, head, lines):
    owners = {f: s for s in plan.get("slices", []) for f in s.get("files", [])}
    out = []
    for imp in head.get("imports", []):
        if not lines & set(range(imp["start"], imp["end"] + 1)):
            continue
        for target in sorted(resolve(rel, imp, owners)):
            other = owners[target]
            if other["id"] != owner["id"] and other["id"] not in owner.get("depends", []):
                fid = f"depends:{rel}:{other['id']}"
                if fid not in {f["id"] for f in out}:
                    out.append(finding(fid, "signature", f"imports {target} from {other['id']}, which is not in {owner['id']} depends", rel, imp["start"]))
    return out


def module_statements(head, head_src, lines):
    """Top-level statements with a changed code line outside every function and class body."""
    inside = set()
    for block in head["functions"] + head.get("classes", []):
        inside.update(range(block["start"], block["end"] + 1))
    text = head_src.split("\n")
    out = []
    for st in head.get("statements", []):
        span = set(range(st["start"], st["end"] + 1))
        code = {n for n in (span & lines) - inside if n <= len(text) and not TRIVIAL.match(text[n - 1])}
        if code:
            out.append(st)
    return out


def done_lines(plan, rel):
    out = set()
    for s in plan.get("slices", []):
        for p in s.get("pseudocode", []):
            m = re.match(r"^(.+):(\d+)$", p.get("done", ""))
            if m and m[1] == rel:
                out.add(int(m[2]))
    return out


def check_file(plan, root, base, rel, phase):
    owner = next((s for s in plan.get("slices", []) if rel in s.get("files", [])), None)
    if owner is None:
        return [finding(f"files:{rel}", "files", "changed file is in no slice", rel)]
    head_src = (root / rel).read_text(encoding="utf-8", errors="replace") if (root / rel).is_file() else None
    base_src = base_source(root, base, rel)
    suffix = pathlib.Path(rel).suffix
    head, old = extract(suffix, head_src), extract(suffix, base_src)
    for f in (head, old):
        if "error" in f:
            return [finding(f"parse:{rel}", "parse", f["error"], rel, level="not-run")]
    lines = changed_lines(root, base, rel, base_src, head_src or "")
    out = []
    touched = [fn for fn in head["functions"] if lines & set(range(fn["start"], fn["end"] + 1))]
    for fn in touched:
        if fn["passthrough"]:
            out.append(finding(f"eta:{rel}:{fn['name']}:{fn['start']}", "eta", "function only passes its parameters to one call", rel, fn["start"]))
    for c in head["calls"]:
        if c["line"] not in lines or allowed(c["name"], owner.get("calls", [])):
            continue
        if MAYBE.search(c["name"]) and not EFFECTS.search(c["name"]):
            detail = f"{c['name']} may be an effect; if it is, add it to {owner['id']} calls"
            out.append(finding(f"effect:{rel}:{c['name']}:{c['line']}", "pure-slice", detail, rel, c["line"], level="consider"))
        elif EFFECTS.search(c["name"]):
            out.append(finding(f"effect:{rel}:{c['name']}", "pure-slice", f"effect call {c['name']} is not in {owner['id']} calls", rel, c["line"]))
    if phase >= 2:
        done = done_lines(plan, rel)
        spans = [(fn["start"], fn["end"]) for fn in head["functions"] if any(fn["start"] <= d <= fn["end"] for d in done)]
        for fn in touched:
            if not any(a <= fn["start"] and fn["end"] <= b for a, b in spans):
                out.append(finding(f"reduction:{rel}:{fn['name']}", "reduction", "changed function maps to no pseudocode line", rel, fn["start"]))
        for st in module_statements(head, head_src or "", lines):
            if not any(st["start"] <= d <= st["end"] for d in done):
                out.append(finding(f"reduction:{rel}:{st['start']}", "reduction", "changed module-level statement maps to no pseudocode line", rel, st["start"]))
    out += check_depends(plan, rel, owner, head, lines)
    for item in sorted(set(head["interface"]) ^ set(old["interface"])):
        if not planned(item, owner.get("interface", [])):
            change = "added or changed" if item in head["interface"] else "removed or changed"
            out.append(finding(f"interface:{rel}:{item}", "interface", f"public interface {change}: {item}", rel))
    return out


def run(plan, root, base, phase, files=None):
    out = []
    for rel in files or changed_files(root, base):
        if pathlib.Path(rel).suffix in PY | JS:
            out += check_file(plan, root, base, rel.replace("\\", "/"), phase)
    return out


def main(argv):
    parser = argparse.ArgumentParser()
    parser.add_argument("plan", type=pathlib.Path)
    parser.add_argument("--base", required=True)
    parser.add_argument("--root", type=pathlib.Path, default=pathlib.Path("."))
    parser.add_argument("--phase", type=int, choices=(1, 2, 3), default=2)
    parser.add_argument("files", nargs="*")
    args = parser.parse_args(argv)
    plan = verify_plan.load_json(args.plan)
    schema = verify_plan.check_keys(plan, args.root)
    if schema:
        print(json.dumps(schema, indent=1))
        return 1
    found = run(plan, args.root.resolve(), args.base, args.phase, args.files)
    print(json.dumps(found, indent=1))
    return 1 if any(f["level"] == "fail" for f in found) else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
