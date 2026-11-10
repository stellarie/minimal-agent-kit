"""Check that each changed hunk is needed: undo it alone, and a test must fail (1-minimal).

Usage: python minimal_check.py --base REV --test "CMD" [--root DIR] [--lines] [--limit N] [--timeout S]
Checks the committed diff merge-base(base, HEAD)..HEAD in a temporary git worktree.
The working tree is not changed. The timeout applies to each test run.
Skips test files and folders, docs and config, hunks that add only comments or blank lines,
and Python changes to docstrings and parameter or return annotations only.
Source files in other languages give one "consider" finding.
A hunk that can be undone with the tests still passing gives a "fail" finding.
The result is only as strong as the tests. Exit 1 when a finding has level "fail".
"""

import argparse
import ast
import json
import os
import pathlib
import re
import shutil
import signal
import subprocess
import sys
import tempfile

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import verify_plan  # noqa: E402

CODE = {".py", ".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx"}
NOT_SOURCE = {
    "", ".md", ".rst", ".txt", ".json", ".jsonc", ".yml", ".yaml", ".toml", ".ini", ".cfg", ".lock",
    ".csv", ".svg", ".png", ".jpg", ".gif", ".dot", ".html", ".css", ".env", ".gitignore", ".gitattributes",
}
HUNK = re.compile(r"^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@")
COMMENT = re.compile(r"^\s*(#|//|/\*|\*(\s|/|$)|$)")
LINKS = ["node_modules", ".venv", "venv"]
TEST_DIRS = {"tests", "test", "__tests__", "spec", "fixtures", "__mocks__"}
DIFF = ["-c", "core.quotePath=false", "diff", "-U0", "--relative", "--no-color", "--no-ext-diff",
        "--no-textconv", "--no-renames", "--src-prefix=a/", "--dst-prefix=b/"]


def finding(fid, level, detail, file="", line=0):
    return {"id": fid, "check": "minimal", "level": level, "file": file, "line": line, "detail": detail}


def git(root, *args):
    return subprocess.run(["git", "-C", str(root), *args], capture_output=True, text=True,
                          encoding="utf-8", errors="surrogateescape")


def parse(diff):
    """Return (hunks, skipped, bad) from `git diff -U0` output.

    hunks: (file, new_start, old_lines, new_lines) for each hunk that adds code.
    skipped: changed source files in a language this script does not check.
    bad: file headers the parser cannot read.
    """
    hunks, skipped, bad = [], set(), []
    rel, old_left, new_left, cur = None, 0, 0, None
    for line in diff.split("\n"):
        if old_left or new_left:
            if line.startswith("-") and old_left:
                old_left -= 1
                cur and cur[2].append(line[1:])
            elif line.startswith("+") and new_left:
                new_left -= 1
                cur and cur[3].append(line[1:])
            continue
        if cur and cur[3] and not all(COMMENT.match(x) for x in cur[3]):
            hunks.append(cur)
        cur = None
        if line.startswith("+++ "):
            path = line[4:].rstrip("\t")
            if path == "/dev/null":
                rel = None
            elif not path.startswith("b/"):
                bad.append(path)
                rel = None
            else:
                path = path[2:]
                name = pathlib.PurePosixPath(path)
                if verify_plan.TEST_FILE.search(name.name) or name.name == "conftest.py" or TEST_DIRS & set(name.parts[:-1]):
                    rel = None
                elif name.suffix in CODE:
                    rel = path
                else:
                    if name.suffix.lower() not in NOT_SOURCE and not name.name.startswith("."):
                        skipped.add(path)
                    rel = None
        elif m := HUNK.match(line):
            old_left = int(m[2]) if m[2] is not None else 1
            new_left = int(m[4]) if m[4] is not None else 1
            cur = (rel, int(m[3]), [], []) if rel else None
    return hunks, sorted(skipped), bad


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
    """Return True (pass), False (fail), or None (timeout). Kills the whole process tree on timeout."""
    env = dict(os.environ, PYTHONDONTWRITEBYTECODE="1")
    opts = {"creationflags": subprocess.CREATE_NEW_PROCESS_GROUP} if os.name == "nt" else {"start_new_session": True}
    p = subprocess.Popen(cmd, shell=True, cwd=cwd, env=env, stdin=subprocess.DEVNULL,
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, **opts)
    try:
        return p.wait(timeout=timeout) == 0
    except subprocess.TimeoutExpired:
        if os.name == "nt":
            subprocess.run(["taskkill", "/T", "/F", "/PID", str(p.pid)], capture_output=True)
        else:
            os.killpg(p.pid, signal.SIGKILL)
        p.wait()
        return None


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
        try:
            os.rmdir(path)
        except OSError:
            pass


def read(path):
    with open(path, encoding="utf-8", errors="surrogateescape", newline="") as f:
        return f.read()


def write(path, text):
    with open(path, "w", encoding="utf-8", errors="surrogateescape", newline="") as f:
        f.write(text)


class Strip(ast.NodeTransformer):
    """Remove docstrings and annotations: they cannot change what a test sees at run time."""

    def generic_visit(self, node):
        super().generic_visit(node)
        body = getattr(node, "body", None)
        if isinstance(body, list) and body and isinstance(body[0], ast.Expr) \
                and isinstance(body[0].value, ast.Constant) and isinstance(body[0].value.value, str):
            node.body = body[1:] or [ast.Pass()]
        # Only parameter and return annotations: class-level ones can be dataclass fields.
        if isinstance(node, ast.arg):
            node.annotation = None
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            node.returns = None
        return node


def same_behaviour(rel, before, after):
    """True when a Python file differs only in docstrings and annotations. None when `after` does not parse."""
    if not rel.endswith(".py"):
        return False
    try:
        new = ast.parse(after)
    except SyntaxError:
        return None
    try:
        old = ast.parse(before)
    except SyntaxError:
        return False
    return ast.dump(Strip().visit(old)) == ast.dump(Strip().visit(new))


def check(tree, cands, cmd, timeout, limit):
    out = []
    broken = 0
    for n, (rel, line, start, count, repl) in enumerate(cands):
        if n >= limit:
            out.append(finding("minimal:limit", "not-run", f"{len(cands) - limit} hunk(s) past the limit of {limit} were not checked"))
            break
        path = tree / rel
        text = read(path)
        body = text.split("\n")
        undone = "\n".join(body[: start - 1] + repl + body[start - 1 + count:])
        same = same_behaviour(rel, text, undone)
        if same:
            continue
        if same is None:
            broken += 1
            continue
        write(path, undone)
        try:
            ok = run_tests(cmd, tree, timeout)
        finally:
            write(path, text)
        fid = f"minimal:{rel}:{line}"
        if ok is None:
            out.append(finding(fid, "not-run", f"tests timed out after {timeout}s with this hunk undone", rel, line))
        elif ok:
            out.append(finding(fid, "fail", "tests still pass with this hunk undone: dead code or a missing test", rel, line))
    if broken:
        out.append(finding("minimal:syntax", "not-run", f"{broken} change(s) could not be undone alone without a syntax error; use hunk mode"))
    return out


def run(root, base, cmd, lines=False, limit=50, timeout=300):
    root = pathlib.Path(root).resolve()
    mb = git(root, "merge-base", base, "HEAD")
    if mb.returncode:
        return [finding("minimal:diff", "not-run", f"no merge base for {base!r} and HEAD: {mb.stderr.strip()[:200]}")]
    diff = git(root, *DIFF, mb.stdout.strip(), "HEAD")
    if diff.returncode:
        return [finding("minimal:diff", "not-run", f"git diff failed: {diff.stderr.strip()[:200]}")]
    found, skipped, bad = parse(diff.stdout)
    out = [finding("minimal:header", "not-run", f"cannot read diff header {b!r}") for b in bad]
    if skipped:
        out.append(finding("minimal:skipped", "consider", "not checked, language not supported: " + ", ".join(skipped)))
    cands = candidates(found, lines)
    if not cands:
        return out
    top = pathlib.Path(git(root, "rev-parse", "--show-toplevel").stdout.strip())
    sub = root.relative_to(top) if root != top else pathlib.Path()
    holder = pathlib.Path(tempfile.mkdtemp(prefix="minimal-"))
    tree_top = holder / "tree"
    if git(top, "-c", "core.hooksPath=" + os.devnull, "worktree", "add", "--detach", str(tree_top), "HEAD").returncode:
        shutil.rmtree(holder, ignore_errors=True)
        return out + [finding("minimal:worktree", "not-run", "git worktree add failed")]
    tree = tree_top / sub
    links = link_deps(root, tree)
    try:
        base_ok = run_tests(cmd, tree, timeout)
        if base_ok is None:
            return out + [finding("minimal:baseline", "not-run", f"tests at HEAD timed out after {timeout}s")]
        if not base_ok:
            return out + [finding("minimal:baseline", "not-run", "tests do not pass at HEAD in the worktree; check the command and dependencies")]
        return out + check(tree, cands, cmd, timeout, limit)
    finally:
        for link in links:
            unlink(link)
        git(top, "worktree", "remove", "--force", str(tree_top))
        shutil.rmtree(holder, ignore_errors=True)
        git(top, "worktree", "prune")


def positive(text):
    n = int(text)
    if n < 1:
        raise argparse.ArgumentTypeError("must be 1 or more")
    return n


def main(argv):
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", required=True)
    parser.add_argument("--test", required=True, help="test command; exit 0 means pass")
    parser.add_argument("--root", type=pathlib.Path, default=pathlib.Path("."))
    parser.add_argument("--lines", action="store_true", help="undo one added line at a time")
    parser.add_argument("--limit", type=positive, default=50)
    parser.add_argument("--timeout", type=positive, default=300, help="seconds for each test run")
    args = parser.parse_args(argv)
    found = run(args.root, args.base, args.test, args.lines, args.limit, args.timeout)
    print(json.dumps(found, indent=1))
    return 1 if any(f["level"] == "fail" for f in found) else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
