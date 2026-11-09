"""Tests for check_tools.py: detection reads config and manifests (C4.1); a missing tool never blocks (C4.2)."""

import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "core" / "verify"))
import check_tools as tools


class DetectTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def found(self, changed):
        return {tool[0]: source for tool, source in tools.detect(self.root, changed)}

    def test_config_file(self):
        (self.root / "ruff.toml").write_text("")
        self.assertEqual("ruff.toml", self.found(["a.py"])["ruff"])

    def test_pyproject_section(self):
        (self.root / "pyproject.toml").write_text("[tool.mypy]\nstrict = true\n")
        self.assertEqual("tool.mypy", self.found(["a.py"])["mypy"])

    def test_package_json_dev_dependency(self):
        (self.root / "package.json").write_text('{"devDependencies": {"eslint": "9.0.0", "typescript": "5.0.0"}}')
        found = self.found(["a.js"])
        self.assertEqual("manifest", found["eslint"])
        self.assertEqual("manifest", found["typescript"])

    def test_no_python_tools_for_js_only(self):
        (self.root / "package.json").write_text("{}")
        self.assertNotIn("ruff", self.found(["a.js"]))

    def test_name_inside_other_word_does_not_match(self):
        (self.root / "requirements.txt").write_text("ruffle==1.0\n")
        self.assertIsNone(self.found(["a.py"])["ruff"])

    def test_missing_tool_is_consider(self):
        (self.root / "requirements.txt").write_text("")
        found = tools.run(self.root, "HEAD", ["a.py"])
        ruff = next(f for f in found if f["id"] == "tool:ruff")
        self.assertEqual("consider", ruff["level"])
        self.assertFalse(any(f["level"] == "fail" for f in found))

    def test_configured_but_not_on_path_is_not_run(self):
        (self.root / "ruff.toml").write_text("")
        (self.root / "a.py").write_text("")
        with mock.patch.object(tools.shutil, "which", return_value=None):
            found = tools.run(self.root, "HEAD", ["a.py"])
        ruff = next(f for f in found if f["id"] == "tool:ruff")
        self.assertEqual("not-run", ruff["level"])


if __name__ == "__main__":
    unittest.main()
