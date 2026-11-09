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
    found = run(plan, args.root.resolve(), args.base, args.phase, args.files)
    print(json.dumps(found, indent=1))
    return 1 if any(f["level"] == "fail" for f in found) else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
