"""Check that each changed hunk is needed: undo it alone, and a test must fail (1-minimal).

Usage: python minimal_check.py --base REV --test "CMD" [--root DIR] [--lines] [--limit N] [--timeout S]
Checks the committed diff base..HEAD in a temporary git worktree. The working tree is not changed.
Skips test files, non-code files, and hunks that add only comments or blank lines.
A hunk that can be undone with the tests still passing gives a "fail" finding.
The result is only as strong as the tests. Exit 1 when a finding has level "fail".
"""

import argparse
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import verify_plan  # noqa: E402

CODE = {".py", ".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx"}
HUNK = re.compile(r"^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@")
COMMENT = re.compile(r"^\s*(#|//|/\*|\*|$)")
LINKS = ["node_modules", ".venv", "venv"]


def finding(fid, level, detail, file="", line=0):
    return {"id": fid, "check": "minimal", "level": level, "file": file, "line": line, "detail": detail}


def git(root, *args):
    return subprocess.run(["git", "-C", str(root), *args], capture_output=True, text=True, encoding="utf-8")


def hunks(root, base):
    """Return (file, new_start, old_lines, new_lines) for each hunk that adds code."""
    out, rel, old, new, start = [], None, [], [], 0

    def flush():
        if rel and new and not all(COMMENT.match(x) for x in new):
            out.append((rel, start, old, new))

    for line in git(root, "diff", "-U0", "--relative", "--no-color", base, "HEAD").stdout.splitlines():
        if line.startswith("+++ "):
            flush()
            old, new = [], []
            path = line[4:]
            path = path[2:] if path.startswith("b/") else None
            skip = path is None or pathlib.Path(path).suffix not in CODE or verify_plan.TEST_FILE.search(pathlib.Path(path).name)
            rel = None if skip else path
        elif m := HUNK.match(line):
            flush()
            old, new, start = [], [], int(m[3])
        elif line.startswith("-") and not line.startswith("---"):
            old.append(line[1:])
        elif line.startswith("+"):
            new.append(line[1:])
    flush()
    return out


def candidates(found, lines):
    """Each candidate is (file, line, replace_start, replace_count, replacement)."""
    out = []
    for rel, start, old, new in found:
        if lines:
            out += [(rel, start + i, start + i, 1, []) for i, text in enumerate(new) if not COMMENT.match(text)]
        else:
            out.append((rel, start, start, len(new), old))
    return out


def run_tests(cmd, cwd, timeout):
    try:
        r = subprocess.run(cmd, shell=True, cwd=cwd, capture_output=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        return None
    return r.returncode == 0


def link_deps(root, tree):
    made = []
    for name in LINKS:
        src, dst = root / name, tree / name
        if not src.is_dir() or dst.exists():
            continue
        try:
            os.symlink(src, dst, target_is_directory=True)
        except OSError:
            if os.name != "nt" or subprocess.run(["cmd", "/c", "mklink", "/J", str(dst), str(src)], capture_output=True).returncode:
                continue
        made.append(dst)
    return made


def unlink(path):
    # Remove the link only; never the directory it points to.
    try:
        os.unlink(path)
    except OSError:
        os.rmdir(path)


def read(path):
    with open(path, encoding="utf-8", newline="") as f:
        return f.read()


def write(path, text):
    with open(path, "w", encoding="utf-8", newline="") as f:
        f.write(text)


def check(tree, cands, cmd, timeout, limit):
    out = []
    for n, (rel, line, start, count, repl) in enumerate(cands):
        if n == limit:
            out.append(finding("minimal:limit", "not-run", f"{len(cands) - limit} hunk(s) past the limit of {limit} were not checked"))
            break
        path = tree / rel
        text = read(path)
        body = text.splitlines(keepends=True)
        eol = "\r\n" if "\r\n" in text else "\n"
        undone = body[: start - 1] + [r + eol for r in repl] + body[start - 1 + count:]
        write(path, "".join(undone))
        try:
            ok = run_tests(cmd, tree, timeout)
        finally:
            write(path, text)
        fid = f"minimal:{rel}:{line}"
        if ok is None:
            out.append(finding(fid, "not-run", f"tests timed out after {timeout}s with this hunk undone", rel, line))
        elif ok:
            out.append(finding(fid, "fail", "tests still pass with this hunk undone: dead code or a missing test", rel, line))
    return out


def run(root, base, cmd, lines=False, limit=50, timeout=300):
    root = pathlib.Path(root).resolve()
    cands = candidates(hunks(root, base), lines)
    if not cands:
        return []
    top = pathlib.Path(git(root, "rev-parse", "--show-toplevel").stdout.strip())
    sub = root.relative_to(top) if root != top else pathlib.Path()
    holder = pathlib.Path(tempfile.mkdtemp(prefix="minimal-"))
    tree_top = holder / "tree"
    git(top, "worktree", "add", "--detach", str(tree_top), "HEAD")
    tree = tree_top / sub
    links = link_deps(root, tree)
    try:
        base_ok = run_tests(cmd, tree, timeout)
        if not base_ok:
            return [finding("minimal:baseline", "not-run", "tests do not pass at HEAD in the worktree; check the command and dependencies")]
        return check(tree, cands, cmd, timeout, limit)
    finally:
        for link in links:
            unlink(link)
        git(top, "worktree", "remove", "--force", str(tree_top))
        shutil.rmtree(holder, ignore_errors=True)


def main(argv):
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", required=True)
    parser.add_argument("--test", required=True, help="test command; exit 0 means pass")
    parser.add_argument("--root", type=pathlib.Path, default=pathlib.Path("."))
    parser.add_argument("--lines", action="store_true", help="undo one added line at a time")
    parser.add_argument("--limit", type=int, default=50)
    parser.add_argument("--timeout", type=int, default=300)
    args = parser.parse_args(argv)
    found = run(args.root, args.base, args.test, args.lines, args.limit, args.timeout)
    print(json.dumps(found, indent=1))
    return 1 if any(f["level"] == "fail" for f in found) else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
