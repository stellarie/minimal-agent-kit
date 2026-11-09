"""Behaviour tests for the guard, written as Given/When/Then cases.

Each case gives a shell command, runs the guard as a hook process,
and checks the exit code the agent runtime acts on.
"""

import json
import pathlib
import subprocess
import sys
import unittest

GUARD = pathlib.Path(__file__).resolve().parents[1] / "core" / "guard" / "guard.py"

DENY = [
    "rm -rf /",
    "rm -fr ~",
    "rm -r -f $HOME",
    "sudo rm --recursive /",
    "rm -rf .",
    "rm -rf '/'",
    "cd /tmp && rm -rf *",
    "bash -c 'rm -rf /'",
    "sh -c \"git reset --hard\"",
    "git push --force",
    "git push -f origin main",
    "git push origin +main",
    "git push --force origin feat/x:main",
    "git reset --hard HEAD~3",
    "git clean -fdx",
    "mkfs.ext4 /dev/sda1",
    "dd if=/dev/zero of=/dev/sda",
    "Remove-Item -Recurse -Force C:\\",
    "psql -c 'DROP DATABASE prod'",
    "format c: /q",
]

PASS = [
    "git status",
    "rm -rf build",
    "rm -rf ./node_modules",
    "rm file.txt",
    "git push origin feat/x",
    "git push --force-with-lease origin feat/x",
    "git push --force origin feat/x",
    "git reset --soft HEAD~1",
    "git clean -n",
    "echo 'rm' > notes.txt",
    "Remove-Item -Recurse dist",
    "python -m unittest",
]


def run(event):
    proc = subprocess.run(
        [sys.executable, str(GUARD)], input=json.dumps(event) if not isinstance(event, str) else event,
        capture_output=True, text=True,
    )
    return proc.returncode


class GuardBehaviour(unittest.TestCase):
    def test_given_destructive_command_when_guarded_then_denied(self):
        for cmd in DENY:
            with self.subTest(cmd=cmd):
                self.assertEqual(run({"tool_name": "Bash", "tool_input": {"command": cmd}}), 2)

    def test_given_safe_command_when_guarded_then_passes(self):
        for cmd in PASS:
            with self.subTest(cmd=cmd):
                self.assertEqual(run({"tool_name": "Bash", "tool_input": {"command": cmd}}), 0)

    def test_given_non_shell_tool_when_guarded_then_passes(self):
        self.assertEqual(run({"tool_name": "Read", "tool_input": {"file_path": "/"}}), 0)

    def test_given_unreadable_event_when_guarded_then_denied(self):
        self.assertEqual(run("not json"), 2)

    def test_given_codex_argv_command_when_destructive_then_denied(self):
        event = {"tool_name": "shell", "tool_input": {"command": ["bash", "-lc", "rm -rf ~"]}}
        self.assertEqual(run(event), 2)

    def test_given_powershell_tool_when_destructive_then_denied(self):
        event = {"tool_name": "PowerShell", "tool_input": {"command": "Remove-Item -Recurse -Force ~"}}
        self.assertEqual(run(event), 2)


if __name__ == "__main__":
    unittest.main()
