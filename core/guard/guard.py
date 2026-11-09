"""Deny destructive shell commands before they run.

Reads one hook event as JSON on stdin. Exit 0 passes. Exit 2 denies,
and stderr carries the reason. The guard only denies. It never grants
a permission, so a parse gap cannot loosen anything.
"""

import json
import os
import re
import shlex
import sys

SHELL_TOOLS = {"Bash", "PowerShell", "shell", "exec_command", "local_shell"}
SPLIT = re.compile(r"\|\||&&|[;|\n&]")
WRAPPERS = {"sudo", "doas", "env", "nohup", "time", "command", "xargs"}
SHELLS = {"sh", "bash", "zsh", "dash", "pwsh", "powershell", "cmd"}

with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "rules.json"), encoding="utf-8") as f:
    RULES = json.load(f)
PATTERNS = [(p["id"], re.compile(p["re"], re.I)) for p in RULES["deny_patterns"]]
DANGEROUS = {p.lower() for p in RULES["dangerous_paths"]}


def tokens(segment):
    try:
        toks = shlex.split(segment, posix=True)
    except ValueError:
        toks = segment.split()
    while toks and (os.path.basename(toks[0]) in WRAPPERS or "=" in toks[0]):
        toks = toks[1:]
    return toks


def is_dangerous(path):
    p = path.lower().rstrip()
    return p in DANGEROUS or p.rstrip("/\\") in {"", "~", "$home", "c:"}


def check_rm(toks):
    name = os.path.basename(toks[0]).lower()
    args = toks[1:]
    if name == "rm":
        flags = "".join(a[1:] for a in args if a.startswith("-") and not a.startswith("--"))
        rec = "r" in flags.lower() or "--recursive" in args
    elif name in {"remove-item", "rmdir", "rd", "del", "ri"}:
        rec = any(a.lower() in {"-recurse", "-r", "/s"} for a in args)
    else:
        return None
    targets = [a for a in args if not a.startswith("-") and not a.startswith("/s")]
    if rec and any(is_dangerous(t) for t in targets):
        return "recursive delete of a root, home, or working directory"
    return None


def check_git(toks):
    if os.path.basename(toks[0]) != "git" or len(toks) < 2:
        return None
    sub, args = toks[1], toks[2:]
    if sub == "push":
        force = any(a in {"--force", "-f"} or (a.startswith("-") and not a.startswith("--") and "f" in a) for a in args)
        refs = [a.lstrip("+") for a in args if not a.startswith("-")][1:]
        plus = any(a.startswith("+") for a in args)
        if force or plus:
            if not refs or any(r.split(":")[-1] in RULES["protected_branches"] for r in refs):
                return "force push to a protected or unnamed branch"
    if sub == "reset" and "--hard" in args:
        return "git reset --hard discards work"
    if sub == "clean" and any(a.startswith("-") and "f" in a for a in args):
        return "git clean -f deletes untracked files"
    return None


def check_segment(segment, depth=0):
    toks = tokens(segment)
    if not toks:
        return None
    reason = check_rm(toks) or check_git(toks)
    if reason or depth > 3:
        return reason
    if os.path.basename(toks[0]).lower() in SHELLS or toks[0] == "eval":
        for arg in toks[1:]:
            if not arg.startswith("-") and not arg.startswith("/"):
                reason = check_command(arg, depth + 1)
                if reason:
                    return reason
    return None


def check_command(command, depth=0):
    for pid, rx in PATTERNS:
        if rx.search(command):
            return f"matches deny pattern '{pid}'"
    for segment in SPLIT.split(command):
        reason = check_segment(segment.strip(), depth)
        if reason:
            return reason
    return None


def main():
    try:
        event = json.load(sys.stdin)
    except (ValueError, OSError):
        print("guard: unreadable hook event; denied", file=sys.stderr)
        return 2
    if event.get("tool_name") not in SHELL_TOOLS:
        return 0
    command = (event.get("tool_input") or {}).get("command")
    if isinstance(command, list):
        command = shlex.join(str(a) for a in command)
    if not isinstance(command, str):
        print("guard: shell call without a command string; denied", file=sys.stderr)
        return 2
    reason = check_command(command)
    if reason:
        print(f"guard: denied: {reason}. Ask the human to run it.", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
