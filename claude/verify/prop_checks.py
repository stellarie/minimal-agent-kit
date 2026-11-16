"""Demand a property test for each `tested` claim, when the project has the library.

Usage: python prop_checks.py PLAN [--root DIR]
Prints findings as JSON (format in plan.schema.md). Exit 1 when a finding has level "fail".
Scope: each `tested` claim with no `cases`. A Python slice needs a test with a `given` decorator
(Hypothesis); a JS or TS slice needs a test file with `fc.assert(` or `fc.property(` (fast-check).
The property test needs a fixed seed. A project that does not name the library gets a "consider"
finding. This script reads project files only. It runs and installs nothing.
"""

import argparse
import ast
import json
import pathlib
import re
import sys

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import verify_plan  # noqa: E402
from check_tools import EXT, MANIFESTS, manifest_text  # noqa: E402
from verify_plan import SKIP_DIRS, TEST_FILE, finding, load_json  # noqa: E402

LIBRARY = {"py": "hypothesis", "js": "fast-check"}
JS_TITLE = re.compile(r"\b(?:test|it)(?:\.\w+)*\s*\(\s*(['\"`])(.*?)\1")
JS_PROP = re.compile(r"\bfc\.(?:assert|property)\(")
PY_SEED = re.compile(r"derandomize\s*=\s*True|@(?:\w+\.)?seed\(")
JS_SEED = re.compile(r"\bseed\s*:|configureGlobal")
SETUP_KEY = re.compile(r"setupFiles\w*[\"']?\s*:\s*(\[[^\]]*\]|[\"'][^\"']*[\"'])")
STRING = re.compile(r"[\"']([^\"']+)[\"']")
SETUP_CONFIGS = ("jest.config.", "vitest.config.")


def name_matches(claim_id, name):
    """Claim C1.1 matches a name with c1_1 in it, not followed by a digit. Case does not matter."""
    key = re.sub(r"\W", "_", claim_id)
    return re.search(re.escape(key) + r"(?!\d)", name, re.I) is not None


def read(path):
    try:
        return path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return ""


def test_files(root, lang):
    out = []
    for path in sorted(root.rglob("*")):
        parts = path.relative_to(root).parts
        if SKIP_DIRS & set(parts) or not path.is_file() or not TEST_FILE.search(path.name):
            continue
        if path.suffix in EXT[lang]:
            out.append(path)
    return out


def has_given(func):
    for d in func.decorator_list:
        d = d.func if isinstance(d, ast.Call) else d
        if (isinstance(d, ast.Name) and d.id == "given") or (isinstance(d, ast.Attribute) and d.attr == "given"):
            return True
    return False


def py_seed_text(root, path):
    """Test file, each conftest.py from its folder up to the root, and the root pyproject.toml."""
    texts = [read(path), read(root / "pyproject.toml")]
    folder = path.parent
    while True:
        texts.append(read(folder / "conftest.py"))
        if folder == root or root not in folder.parents:
            break
        folder = folder.parent
    return "\n".join(texts)


def js_setup_files(root):
    """Setup files named in the jest or vitest config. Simple regex only; other forms are not read."""
    sources = []
    pkg = root / "package.json"
    if pkg.is_file():
        try:
            sources.append(json.dumps(json.loads(read(pkg)).get("jest", {})))
        except ValueError:
            pass
    sources += [read(p) for p in root.iterdir() if p.name.startswith(SETUP_CONFIGS)]
    out = []
    for src in sources:
        for m in SETUP_KEY.finditer(src):
            for s in STRING.findall(m[1]):
                p = root / s.replace("<rootDir>/", "")
                if p.is_file():
                    out.append(p)
    return out


def py_claim(root, claim_id, unread):
    """Return (property test found, seed fixed) for the Python tests of a claim."""
    found = seeded = False
    for path in test_files(root, "py"):
        text = read(path)
        if not name_matches(claim_id, text):
            continue
        try:
            tree = ast.parse(text)
        except (SyntaxError, ValueError):
            unread.add(path.relative_to(root).as_posix())
            continue
        for node in ast.walk(tree):
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and name_matches(claim_id, node.name) and has_given(node):
                found = True
                seeded = seeded or bool(PY_SEED.search(py_seed_text(root, path)))
    return found, seeded


def js_claim(root, claim_id, unread):
    found = seeded = False
    setup = "\n".join(read(p) for p in js_setup_files(root))
    for path in test_files(root, "js"):
        text = read(path)
        if any(name_matches(claim_id, m[2]) for m in JS_TITLE.finditer(text)) and JS_PROP.search(text):
            found = True
            seeded = seeded or bool(JS_SEED.search(text + "\n" + setup))
    return found, seeded


def languages(slice_):
    suffixes = {pathlib.PurePosixPath(f).suffix for f in slice_.get("files", [])}
    return [lang for lang in ("py", "js") if suffixes & EXT[lang]]


def run(plan, root):
    manifests = manifest_text(root)
    out, missing, unread = [], set(), set()
    for s in plan.get("slices", []):
        for c in s.get("claims", []):
            if c.get("strength") != "tested" or c.get("cases"):
                continue
            cid = str(c["id"])
            for lang in languages(s):
                if LIBRARY[lang] not in manifests:
                    missing.add(lang)
                    continue
                found, seeded = (py_claim if lang == "py" else js_claim)(root, cid, unread)
                if not found:
                    out.append(finding(f"property:{cid}", "property", f"no test of {cid} is a property test ({LIBRARY[lang]})"))
                elif not seeded:
                    out.append(finding(f"property-seed:{cid}", "property", f"the property test of {cid} has no fixed seed"))
    for lang in sorted(missing):
        out.append(finding(f"property:library:{lang}", "property", f"{LIBRARY[lang]} is not in {', '.join(MANIFESTS)}: consider it", level="consider"))
    for rel in sorted(unread):
        out.append(finding(f"property:unread:{rel}", "property", "test file cannot be parsed", rel, level="not-run"))
    seen = set()
    return [f for f in out if not (f["id"] in seen or seen.add(f["id"]))]


def main(argv):
    parser = argparse.ArgumentParser()
    parser.add_argument("plan", type=pathlib.Path)
    parser.add_argument("--root", type=pathlib.Path, default=pathlib.Path("."))
    args = parser.parse_args(argv)
    plan = load_json(args.plan)
    schema = verify_plan.check_keys(plan, args.root)
    if schema:
        print(json.dumps(schema, indent=1))
        return 1
    found = run(plan, args.root.resolve())
    print(json.dumps(found, indent=1))
    return 1 if any(f["level"] == "fail" for f in found) else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
