"""Run the check tools a project has configured. Turn each result into a finding.

Usage: python check_tools.py --base REV [--root DIR] [--list]
A tool counts as configured when its config file exists, or the project names it in a
dependency manifest. A missing tool gives a "consider" finding, which never blocks a gate.
This script installs nothing.
"""

import argparse
import json
import pathlib
import re
import shutil
import subprocess
import sys

MANIFESTS = ["pyproject.toml", "requirements.txt", "requirements-dev.txt", "dev-requirements.txt", "setup.cfg", "package.json"]

# name, language, config files, pyproject/setup.cfg section, command (FILES = changed files)
TOOLS = [
    ("ruff", "py", ["ruff.toml", ".ruff.toml"], "tool.ruff", ["ruff", "check", "FILES"]),
    ("mypy", "py", ["mypy.ini", ".mypy.ini"], "tool.mypy", ["mypy", "FILES"]),
    ("pyright", "py", ["pyrightconfig.json"], "tool.pyright", ["pyright", "FILES"]),
    ("bandit", "py", [".bandit"], "tool.bandit", ["bandit", "-q", "FILES"]),
    ("vulture", "py", [], "tool.vulture", ["vulture", "FILES"]),
    ("pip-audit", "py", [], None, ["pip-audit"]),
    ("diff-cover", "py", [], None, ["diff-cover", "coverage.xml", "--compare-branch", "BASE"]),
    ("mutmut", "py", [], "tool.mutmut", ["mutmut", "run"]),
    ("eslint", "js", ["eslint.config.js", "eslint.config.mjs", "eslint.config.cjs", ".eslintrc", ".eslintrc.js", ".eslintrc.json", ".eslintrc.cjs"], None, ["npx", "--no-install", "eslint", "FILES"]),
    ("typescript", "js", ["tsconfig.json"], None, ["npx", "--no-install", "tsc", "--noEmit"]),
    ("knip", "js", ["knip.json", "knip.jsonc", ".knip.json"], None, ["npx", "--no-install", "knip"]),
    ("c8", "js", [".c8rc", ".c8rc.json"], None, ["npx", "--no-install", "c8", "check-coverage"]),
    ("@stryker-mutator/core", "js", ["stryker.conf.js", "stryker.conf.mjs", "stryker.config.json", "stryker.conf.json"], None, ["npx", "--no-install", "stryker", "run"]),
    ("npm-audit", "js", ["package-lock.json"], None, ["npm", "audit", "--audit-level=high"]),
    ("semgrep", "any", [".semgrep.yml", ".semgrep.yaml", ".semgrep"], None, ["semgrep", "scan", "--error", "--config", "CONFIG", "FILES"]),
]
EXT = {"py": {".py"}, "js": {".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx"}}


def finding(name, level, detail):
    return {"id": f"tool:{name}", "check": "tool", "level": level, "file": "", "line": 0, "detail": detail}


def manifest_text(root):
    return "\n".join((root / m).read_text(encoding="utf-8", errors="replace") for m in MANIFESTS if (root / m).is_file())


def languages(root, changed):
    langs = {lang for lang, exts in EXT.items() if any(pathlib.Path(f).suffix in exts for f in changed)}
    if (root / "package.json").is_file():
        langs.add("js")
    if any((root / m).is_file() for m in MANIFESTS[:5]):
        langs.add("py")
    return langs


def configured(root, tool, manifests):
    name, _, files, section, _ = tool
    found = [f for f in files if (root / f).exists()]
    if found:
        return found[0]
    if section and re.search(r"^\[" + re.escape(section) + r"[\].]", manifests, re.M):
        return section
    if re.search(r"(^|[\s\"'\[])" + re.escape(name) + r"([\s\"'=<>~!\[;,]|$)", manifests, re.M):
        return "manifest"
    return None


def detect(root, changed):
    langs, manifests = languages(root, changed), manifest_text(root)
    out = []
    for tool in TOOLS:
        if tool[1] == "any" or tool[1] in langs:
            out.append((tool, configured(root, tool, manifests)))
    return out


def command(tool, source, base, changed):
    files = [f for f in changed if tool[1] == "any" or pathlib.Path(f).suffix in EXT[tool[1]]]
    cmd = []
    for part in tool[4]:
        if part == "FILES":
            cmd += files
        elif part == "BASE":
            cmd.append(base)
        elif part == "CONFIG":
            cmd.append(source)
        else:
            cmd.append(part)
    return cmd, files


def run(root, base, changed):
    out = []
    for tool, source in detect(root, changed):
        name = tool[0]
        if source is None:
            out.append(finding(name, "consider", f"not configured: consider {name}"))
            continue
        cmd, files = command(tool, source, base, changed)
        if "FILES" in tool[4] and not files:
            out.append(finding(name, "pass", "no changed files for this tool"))
            continue
        exe = shutil.which(cmd[0])
        if not exe:
            out.append(finding(name, "not-run", f"configured in {source}, but {cmd[0]} is not on PATH"))
            continue
        r = subprocess.run([exe] + cmd[1:], cwd=root, capture_output=True, text=True, encoding="utf-8", errors="replace")
        tail = (r.stdout + r.stderr).strip().splitlines()[-5:]
        level = "pass" if r.returncode == 0 else "fail"
        out.append(finding(name, level, f"{' '.join(cmd[:3])}: exit {r.returncode}. " + " | ".join(tail)))
    return out


def main(argv):
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", required=True)
    parser.add_argument("--root", type=pathlib.Path, default=pathlib.Path("."))
    parser.add_argument("--list", action="store_true", help="show detection only; run nothing")
    args = parser.parse_args(argv)
    root = args.root.resolve()
    diff = subprocess.run(["git", "-C", str(root), "diff", "--name-only", args.base], capture_output=True, text=True)
    changed = [f for f in diff.stdout.split() if (root / f).is_file()]
    if args.list:
        for tool, source in detect(root, changed):
            print(f"{tool[0]:24} {source or 'not configured'}")
        return 0
    found = run(root, args.base, changed)
    print(json.dumps(found, indent=1))
    return 1 if any(f["level"] == "fail" for f in found) else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
