"""Behaviour tests for tools/vendor_memory.py.

Set AGENT_MEMORY_SOURCE to an upstream checkout to run the source tests.
"""

import json
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "tools"))
from vendor_memory import Renamer  # noqa: E402

REPO = pathlib.Path(__file__).resolve().parents[1]
SCRIPT = REPO / "tools" / "vendor_memory.py"
SOURCE = pathlib.Path(os.environ.get("AGENT_MEMORY_SOURCE", "")).resolve() if os.environ.get("AGENT_MEMORY_SOURCE") else None
MAP = os.environ.get("AGENT_MEMORY_MAP")


def check(source):
    args = [sys.executable, str(SCRIPT), "--check", "--source", str(source)]
    if MAP:
        args += ["--map", MAP]
    return subprocess.run(args, capture_output=True, text=True).returncode


@unittest.skipUnless(SOURCE and (SOURCE / "plugins").is_dir(), "AGENT_MEMORY_SOURCE not set")
class VendorMemoryBehaviour(unittest.TestCase):
    def test_given_current_copy_when_checked_then_exits_zero(self):
        self.assertEqual(check(SOURCE), 0)

    def test_given_changed_source_when_checked_then_exits_one(self):
        with tempfile.TemporaryDirectory() as tmp:
            src = pathlib.Path(tmp) / SOURCE.name
            shutil.copytree(SOURCE, src, ignore=shutil.ignore_patterns(".git", "node_modules"))
            store = src / "plugins" / SOURCE.name / "src" / "store.mjs"
            store.write_text(store.read_text(encoding="utf-8") + "\n// drift\n", encoding="utf-8")
            self.assertEqual(check(src), 1)

    def test_given_vendored_copy_when_searched_then_no_old_names(self):
        extra = json.loads(pathlib.Path(MAP).read_text(encoding="utf-8")) if MAP else None
        self.assertEqual(Renamer(SOURCE.name, extra).missed(REPO / "memory"), [])


class VendoredCopyBehaviour(unittest.TestCase):
    def test_given_vendored_copy_when_read_then_named_agent_memory(self):
        pkg = json.loads((REPO / "memory" / "package.json").read_text(encoding="utf-8"))
        self.assertEqual(pkg["name"], "agent-memory")

    def test_given_renamer_when_text_has_old_names_then_all_replaced(self):
        rename = Renamer("demo-memory")
        out = rename("demo-memory DEMO_MEMORY_HOME DEMO_RUNTIME dmem DMEM plugins/demo-memory/x")
        self.assertEqual(out, "agent-memory AGENT_MEMORY_HOME AGENT_MEMORY_RUNTIME amem AMEM x")

    def test_given_extra_map_when_name_left_then_reported(self):
        rename = Renamer("demo-memory", {"carol": "agent-b"})
        self.assertEqual(rename("hi carol"), "hi agent-b")
        with tempfile.TemporaryDirectory() as tmp:
            (pathlib.Path(tmp) / "f.txt").write_text("carol", encoding="utf-8")
            self.assertEqual(rename.missed(pathlib.Path(tmp)), ["f.txt"])


if __name__ == "__main__":
    unittest.main()
