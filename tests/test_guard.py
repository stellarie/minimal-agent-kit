"""Behaviour tests for the guard, written as Given/When/Then cases.

Each case gives a hook event, runs `node core/guard/guard.js` as a hook
process, and checks the permission decision the agent runtime acts on.
"""

import http.server
import json
import os
import pathlib
import subprocess
import threading
import unittest

GUARD = pathlib.Path(__file__).resolve().parents[1] / "core" / "guard" / "guard.js"

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
    "git reset --soft HEAD~1",
    "git clean -n",
    "echo 'rm' > notes.txt",
    "Remove-Item -Recurse dist",
    "python -m unittest",
]

ASK = "git clean -fdx"

# Each of these is a hard deny, not a prompt.
HARD = [
    "sh -c \"git reset --hard\"",
    "git reset --hard HEAD~3",
    "bash -c 'git reset --hard'",
    "pwsh -Command \"git reset --hard\"",
    "psql -c 'DROP DATABASE prod'",
    "mysql -e 'drop database prod'",
    "sqlite3 app.db 'DROP SCHEMA s'",
    "sqlcmd -Q \"DROP DATABASE prod\"",
    # Pushing needs the human anyway, so a force push to any branch is denied.
    "git push --force origin feat/x",
    "git push --force-with-lease origin feat/x",
]

TOKEN = {"LOUNGE_GUARD_TOKEN": "t"}


def bash(command):
    return {"tool_name": "Bash", "tool_input": {"command": command}, "cwd": str(GUARD.parent)}


def run(event, env=None):
    """Run the guard on one event. Return the decision and the parsed output."""
    full = {k: v for k, v in os.environ.items() if not k.startswith("LOUNGE_")}
    full.update(env or {})
    proc = subprocess.run(
        ["node", str(GUARD)], input=event if isinstance(event, str) else json.dumps(event),
        capture_output=True, text=True, env=full,
    )
    out = json.loads(proc.stdout)["hookSpecificOutput"]
    return out["permissionDecision"], out


class Queue(http.server.BaseHTTPRequestHandler):
    """A lounge core stand-in. It answers each POST with the server's reply."""

    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("content-length", 0)))
        self.server.seen.append((self.path, json.loads(body)))
        payload = json.dumps(self.server.reply).encode()
        self.send_response(self.server.status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, *args):
        pass


class Lounge:
    def __init__(self, reply, status=200):
        self.server = http.server.HTTPServer(("127.0.0.1", 0), Queue)
        self.server.reply, self.server.status, self.server.seen = reply, status, []
        self.url = f"http://127.0.0.1:{self.server.server_port}"
        self.env = {"LOUNGE_GUARD_URL": self.url, **TOKEN}

    def __enter__(self):
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        return self

    def __exit__(self, *exc):
        self.server.shutdown()
        self.server.server_close()


class GuardBehaviour(unittest.TestCase):
    def test_given_destructive_command_when_guarded_then_not_allowed(self):
        for cmd in DENY:
            with self.subTest(cmd=cmd):
                self.assertNotEqual(run(bash(cmd))[0], "allow")

    def test_given_hard_command_when_guarded_then_denied(self):
        for cmd in HARD:
            with self.subTest(cmd=cmd):
                self.assertEqual(run(bash(cmd))[0], "deny")

    def test_given_safe_command_when_guarded_then_allowed(self):
        for cmd in PASS:
            with self.subTest(cmd=cmd):
                self.assertEqual(run(bash(cmd))[0], "allow")

    def test_given_non_shell_tool_when_guarded_then_allowed(self):
        self.assertEqual(run({"tool_name": "Read", "tool_input": {"file_path": "/"}})[0], "allow")

    def test_given_unreadable_event_when_guarded_then_denied(self):
        self.assertEqual(run("not json")[0], "deny")

    def test_given_codex_argv_command_when_destructive_then_denied(self):
        event = {"tool_name": "shell", "tool_input": {"command": ["bash", "-lc", "rm -rf ~"]}}
        self.assertEqual(run(event)[0], "deny")

    def test_given_powershell_tool_when_destructive_then_denied(self):
        event = {"tool_name": "PowerShell", "tool_input": {"command": "Remove-Item -Recurse -Force ~"}}
        self.assertEqual(run(event)[0], "deny")

    def test_given_codex_exec_command_when_destructive_then_denied(self):
        event = {"tool_name": "exec_command", "tool_input": {"cmd": "rm -rf ~"}}
        self.assertEqual(run(event)[0], "deny")

    def test_given_shell_call_without_command_when_guarded_then_denied(self):
        self.assertEqual(run({"tool_name": "Bash", "tool_input": {}})[0], "deny")


class GuardCode(unittest.TestCase):
    """Running or reading the guard code is fine. Writing or deleting it asks."""

    def test_guard_code_run_allows(self):
        self.assertNotEqual(run(bash("node core/guard/guard.js"))[0], "ask")

    def test_guard_code_read_allows(self):
        self.assertNotEqual(run(bash("cat core/guard/rules.js"))[0], "ask")

    def test_guard_code_write_asks(self):
        self.assertEqual(run(bash("echo x > core/guard/rules.js"))[0], "ask")

    def test_guard_code_delete_asks(self):
        self.assertEqual(run(bash("rm claude/guard/guard.js"))[0], "ask")

    def test_guard_code_edit_tool_asks(self):
        edit = {"file_path": str(GUARD.parent / "rules.js"), "old_string": "a", "new_string": "b"}
        self.assertEqual(run({"tool_name": "Edit", "tool_input": edit, "cwd": str(GUARD.parent)})[0], "ask")


class GuardClaims(unittest.TestCase):
    def test_c1_1_allow(self):
        decision, out = run(bash("git status"))
        self.assertEqual((decision, out["hookEventName"]), ("allow", "PreToolUse"))

    def test_c1_1_deny(self):
        self.assertEqual(run(bash("rm -rf /"))[0], "deny")

    def test_c1_1_ask_native(self):
        self.assertEqual(run(bash(ASK))[0], "ask")

    def test_c1_1_ask_lounge(self):
        event = bash(ASK)
        with Lounge({"decision": "allow", "asked": True}) as lounge:
            self.assertEqual(run(event, lounge.env)[0], "allow")
            self.assertEqual(lounge.server.seen[0][0], "/guard/check")
            self.assertEqual(lounge.server.seen[0][1]["input"], event["tool_input"])
        with Lounge({"decision": "deny", "reason": "no"}) as lounge:
            self.assertEqual(run(event, lounge.env)[0], "deny")
        with Lounge({"message": "bad"}, status=500) as lounge:
            self.assertEqual(run(event, lounge.env)[0], "deny")
        with Lounge({}) as lounge:
            env = lounge.env
        self.assertEqual(run(event, env)[0], "deny")

    def test_c1_1_ask_lounge_without_token_denies(self):
        with Lounge({"decision": "allow"}) as lounge:
            self.assertEqual(run(bash(ASK), {"LOUNGE_GUARD_URL": lounge.url})[0], "deny")
            self.assertEqual(lounge.server.seen, [])

    def test_c1_1_ask_lounge_ignores_mode(self):
        event = {**bash(ASK), "permission_mode": "bypassPermissions"}
        with Lounge({"decision": "allow"}) as lounge:
            self.assertEqual(run(event, lounge.env)[0], "allow")

    def test_c1_1_ask_bypass_denies(self):
        decision, out = run({**bash(ASK), "permission_mode": "bypassPermissions"})
        self.assertEqual(decision, "deny")
        self.assertIn("ask the human", out["permissionDecisionReason"])

    def test_c1_1_ask_dontask_denies(self):
        self.assertEqual(run({**bash(ASK), "permission_mode": "dontAsk"})[0], "deny")

    def test_c1_1_bad_json(self):
        for text in ["not json", "", "null", "[]"]:
            with self.subTest(text=text):
                self.assertEqual(run(text)[0], "deny")

    def test_c1_1_block_ignores_lounge(self):
        with Lounge({"decision": "allow"}) as lounge:
            self.assertEqual(run(bash("rm -rf /"), lounge.env)[0], "deny")
            self.assertEqual(lounge.server.seen, [])


    def test_c1_3_matcher_covers_shell_tools(self):
        hooks = json.loads((GUARD.parents[2] / "claude" / "hooks" / "hooks.json").read_text(encoding="utf-8"))
        entry = hooks["hooks"]["PreToolUse"][0]
        for tool in ["Bash", "PowerShell"]:
            self.assertRegex(tool, f"^(?:{entry['matcher']})$")
        self.assertIn("node", entry["hooks"][0]["command"])
        self.assertIn("guard/guard.js", entry["hooks"][0]["command"])


class GuardScenarios(unittest.TestCase):
    def test_sc1_deny(self):
        self.assertEqual(run(bash("rm -rf /"))[0], "deny")

    def test_sc2_ask_native(self):
        self.assertEqual(run(bash(ASK))[0], "ask")

    def test_sc3_bad_json(self):
        self.assertEqual(run("{not json")[0], "deny")


if __name__ == "__main__":
    unittest.main()
