"""Tests for plan_dot.py: write a skeleton, then check each way the diagram can disagree with the plan."""

import contextlib
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

CORE = Path(__file__).resolve().parents[1] / "core" / "verify"
sys.path.insert(0, str(CORE))
import plan_dot

PLAN = {
    "goal": "g",
    "slices": [
        {"id": "S1", "files": ["a.py"], "depends": []},
        {"id": "S2", "files": ["b.py"], "depends": ["S1"]},
        {"id": "S3", "files": ["c.py"], "depends": ["S2"]},
    ],
}


class PlanDotTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.plan = self.root / "p.plan.json"
        self.plan.write_text(json.dumps(PLAN))
        self.dot = self.root / "design.dot"

    def tearDown(self):
        self.tmp.cleanup()

    def run_main(self, *argv):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = plan_dot.main([str(self.plan), *argv])
        return code, json.loads(out.getvalue())

    def check(self):
        code, found = self.run_main("--check", str(self.dot))
        return code, {f["id"]: f for f in found}

    def written(self):
        self.assertEqual(0, self.run_main("--write", str(self.dot))[0])
        return self.dot.read_text()

    def test_write_then_check_passes(self):
        text = self.written()
        self.assertTrue(text.startswith("digraph design {"))
        self.assertIn('bgcolor="#0F172A"', text)
        self.assertEqual((0, {}), self.check())

    def test_write_refuses_to_overwrite(self):
        self.dot.write_text("digraph design {}")
        code, found = self.run_main("--write", str(self.dot))
        self.assertEqual(1, code)
        self.assertEqual("fail", found[0]["level"])
        self.assertEqual("digraph design {}", self.dot.read_text())

    def test_missing_edge(self):
        text = self.written().replace('"S1" -> "S2";', "")
        self.dot.write_text(text)
        code, ids = self.check()
        self.assertEqual(1, code)
        self.assertEqual({"diagram:edge:S1-S2"}, set(ids))
        self.assertEqual("fail", ids["diagram:edge:S1-S2"]["level"])

    def test_extra_edge(self):
        text = self.written().rstrip().rstrip("}") + '  "S1" -> "S3";\n}\n'
        self.dot.write_text(text)
        self.assertEqual({"diagram:extra:S1-S3"}, set(self.check()[1]))

    def test_missing_node(self):
        text = self.written().replace('"S2" -> "S3";', "").replace('"S3";', "")
        self.dot.write_text(text)
        self.assertEqual({"diagram:node:S3", "diagram:edge:S2-S3"}, set(self.check()[1]))

    def test_renamed_node(self):
        text = self.written().replace("S3", "S9")
        self.dot.write_text(text)
        self.assertEqual(
            {"diagram:node:S3", "diagram:unknown:S9", "diagram:edge:S2-S3"}, set(self.check()[1])
        )

    def test_free_node_and_cluster_give_none(self):
        text = self.written().rstrip().rstrip("}")
        text += '  cache [label="Cache"];\n  S2 -> cache;\n  cache -> S3 [style=dashed];\n'
        text += '  subgraph S9 { label="group"; style="rounded,dashed"; db; log; db -> log; }\n}\n'
        self.dot.write_text(text)
        self.assertEqual((0, {}), self.check())

    def test_plan_without_edges(self):
        self.plan.write_text(json.dumps({"slices": [{"id": "S1", "depends": []}]}))
        self.written()
        self.assertEqual((0, {}), self.check())

    def test_no_dot_on_path(self):
        self.written()
        empty = self.root / "empty"
        empty.mkdir()
        with mock.patch.dict(os.environ, {"PATH": str(empty)}):
            code, ids = self.check()
        self.assertEqual(0, code)
        self.assertEqual("not-run", ids["diagram:dot"]["level"])

    def test_dot_cannot_read_file(self):
        self.dot.write_text("digraph { S1 -> ")
        code, ids = self.check()
        self.assertEqual(0, code)
        self.assertEqual("not-run", ids["diagram:dot"]["level"])
        self.assertTrue(ids["diagram:dot"]["detail"])

    def test_cli_exit_code(self):
        script = str(CORE / "plan_dot.py")
        run = lambda *a: subprocess.run(
            [sys.executable, script, str(self.plan), *a], capture_output=True, text=True
        )
        self.assertEqual(0, run("--write", str(self.dot)).returncode)
        self.assertEqual(0, run("--check", str(self.dot)).returncode)
        self.dot.write_text(self.dot.read_text().replace('"S1" -> "S2";', ""))
        r = run("--check", str(self.dot))
        self.assertEqual(1, r.returncode)
        self.assertEqual("diagram:edge:S1-S2", json.loads(r.stdout)[0]["id"])


if __name__ == "__main__":
    unittest.main()
