"""Compare the plan with the changed code, from syntax facts.

Usage: python ast_checks.py PLAN --base REV [--root DIR] [--phase 1|2|3] [FILE ...]
Prints findings as JSON (format in plan.schema.md). Exit 1 when a finding has level "fail".
Checks: files outside every slice, eta, effect calls not in the slice, functions without a
pseudocode `done` location (phase 2 and later), and public interface changes not in the slice.
"""

import argparse
import json
import pathlib
import re
import shutil
import subprocess
import sys

HERE = pathlib.Path(__file__).resolve().parent
PY = {".py"}
JS = {".js", ".mjs", ".cjs", ".jsx"}
EFFECTS = re.compile(
    r"^(open|print|input|exec|eval|fetch|require)$"
    r"|^(os|shutil|subprocess|requests|httpx|urllib|socket|random|logging|pickle|sqlite3|fs|http|https"
    r"|child_process|axios|localStorage|sessionStorage|console)\."
    r"|^(os\.environ|os\.getenv|process\.env|process\.exit|time\.time|time\.sleep|Math\.random|Date\.now|json\.dump)"
    r"|\.(write|write_text|write_bytes|writeFile|writeFileSync|appendFile|unlink|unlinkSync|rmdir|mkdir|remove|rm|rmSync|send|query|execute)$"
)
HUNK = re.compile(r"^@@ -\S+ \+(\d+)(?:,(\d+))? @@", re.M)


def finding(fid, check, detail, file="", line=0, level="fail"):
    return {"id": fid, "check": check, "level": level, "file": file, "line": line, "detail": detail}


def git(root, *args):
    return subprocess.run(["git", "-C", str(root), *args], capture_output=True, text=True, encoding="utf-8")


def changed_files(root, base):
    tracked = git(root, "diff", "--name-only", base).stdout.split()
    new = git(root, "ls-files", "--others", "--exclude-standard").stdout.split()
    return sorted(set(tracked) | set(new))


def base_source(root, base, rel):
    r = git(root, "show", f"{base}:{rel}")
    return r.stdout if r.returncode == 0 else None


def changed_lines(root, base, rel, base_src, head_src):
    if base_src is None:
        return set(range(1, head_src.count("\n") + 2))
    out = set()
    for m in HUNK.finditer(git(root, "diff", "-U0", base, "--", rel).stdout):
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


def symbol(item):
    words = re.findall(r"[A-Za-z_$][\w$]*", item.split("(")[0].split("{")[0])
    return words[-1] if words else item


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
            out.append(finding(f"eta:{rel}:{fn['name']}", "eta", "function only passes its parameters to one call", rel, fn["start"]))
    for c in head["calls"]:
        if c["line"] in lines and EFFECTS.search(c["name"]) and not allowed(c["name"], owner.get("calls", [])):
            out.append(finding(f"effect:{rel}:{c['name']}", "pure-slice", f"effect call {c['name']} is not in {owner['id']} calls", rel, c["line"]))
    if phase >= 2:
        done = done_lines(plan, rel)
        spans = [(fn["start"], fn["end"]) for fn in head["functions"] if any(fn["start"] <= d <= fn["end"] for d in done)]
        for fn in touched:
            if not any(a <= fn["start"] and fn["end"] <= b for a, b in spans):
                out.append(finding(f"reduction:{rel}:{fn['name']}", "reduction", "changed function maps to no pseudocode line", rel, fn["start"]))
    for item in sorted(set(head["interface"]) ^ set(old["interface"])):
        if symbol(item) not in {e.split(".")[-1] for e in owner.get("interface", [])}:
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
    plan = json.loads(args.plan.read_text(encoding="utf-8"))
    found = run(plan, args.root.resolve(), args.base, args.phase, args.files)
    print(json.dumps(found, indent=1))
    return 1 if any(f["level"] == "fail" for f in found) else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
