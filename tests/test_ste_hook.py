"""Behaviour tests for the STE PostToolUse hook in the Claude target."""

import json
import pathlib
import subprocess
import sys
import tempfile
import unittest

HOOK = pathlib.Path(__file__).resolve().parents[1] / "claude" / "hooks" / "ste_hook.py"


def run(path):
    event = {"tool_name": "Write", "tool_input": {"file_path": str(path)}}
    proc = subprocess.run([sys.executable, str(HOOK)], input=json.dumps(event), capture_output=True, text=True)
    return proc.returncode, proc.stderr


class SteHookBehaviour(unittest.TestCase):
    def write(self, name, text):
        path = pathlib.Path(self.tmp.name) / name
        path.write_text(text, encoding="utf-8")
        return path

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()

    def tearDown(self):
        self.tmp.cleanup()

    def test_given_wordy_markdown_when_written_then_agent_is_warned(self):
        path = self.write("a.md", "There is a file that might perhaps be updated by the build at some point in time later on today.\n")
        code, err = run(path)
        self.assertEqual(code, 2)
        self.assertIn("STE100", err)

    def test_given_clean_markdown_when_written_then_silent(self):
        code, err = run(self.write("b.md", "Run the build. Check the log.\n"))
        self.assertEqual((code, err), (0, ""))

    def test_given_non_markdown_file_when_written_then_silent(self):
        code, _ = run(self.write("c.py", "There is maybe a thing that was done.\n"))
        self.assertEqual(code, 0)


if __name__ == "__main__":
    unittest.main()
