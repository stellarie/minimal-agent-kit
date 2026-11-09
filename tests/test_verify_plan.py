"""Tests for verify_plan.py: each rule finds its broken case (C1.1), a valid plan passes (C1.2)."""

import copy
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "core" / "verify"))
import verify_plan

VALID = {
    "goal": "g",
    "acceptance": ["A1"],
    "parts": [{"name": "p", "acceptance": "A1"}],
    "slices": [
        {
            "id": "S1", "files": ["a.py"], "depends": [], "parallel": ["S2"],
            "inputs": [{"field": "x", "source": "a.py:1"}], "outputs": ["y"],
            "effects": {"reads": [], "writes": ["out/a.json"]},
            "scenarios": ["SC1"],
            "claims": [{"id": "C1.1", "strength": "tested", "evidence": "a.py:2"}],
            "pseudocode": [{"line": 1, "text": "y = f(x)", "done": "a.py:2"}],
        },
        {
            "id": "S2", "files": ["b.py"], "depends": [], "parallel": ["S1"],
            "inputs": [], "outputs": ["z"], "effects": {"reads": [], "writes": []},
            "scenarios": [], "claims": [], "pseudocode": [],
        },
        {
            "id": "S3", "files": ["c.py"], "depends": ["S1"], "parallel": [],
            "inputs": [{"field": "y", "source": "S1.y"}], "outputs": [],
            "effects": {"reads": [], "writes": []}, "scenarios": [], "claims": [], "pseudocode": [],
        },
    ],
    "composition": [{"id": "K0", "statement": "s", "justification": "a.py:1"}],
    "accepted": [],
}


class VerifyPlanTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        (self.root / "a.py").write_text("x = 1\ny = 2\n")
        (self.root / "tests").mkdir()
        (self.root / "tests" / "test_a.py").write_text("def test_SC1(): pass\n")

    def tearDown(self):
        self.tmp.cleanup()

    def ids(self, plan, phase=2):
        found, blocking = verify_plan.verify(plan, self.root, phase)
        return {f["id"] for f in blocking}

    def test_valid_plan_passes(self):
        self.assertEqual(set(), self.ids(VALID))

    def broken(self):
        return copy.deepcopy(VALID)

    def test_missing_source(self):
        p = self.broken()
        p["slices"][0]["inputs"][0]["source"] = ""
        self.assertIn("source:S1.x", self.ids(p))

    def test_source_not_in_depends(self):
        p = self.broken()
        p["slices"][2]["depends"] = []
        self.assertIn("source:S3.y", self.ids(p))

    def test_source_not_an_output(self):
        p = self.broken()
        p["slices"][2]["inputs"][0]["source"] = "S1.nope"
        self.assertIn("source:S3.y", self.ids(p))

    def test_ref_past_end(self):
        p = self.broken()
        p["slices"][0]["claims"][0]["evidence"] = "a.py:99"
        self.assertIn("ref:C1.1:a.py:99", self.ids(p))

    def test_ref_missing_file(self):
        p = self.broken()
        p["composition"][0]["justification"] = "gone.py:1"
        self.assertIn("ref:K0:gone.py:1", self.ids(p))

    def test_lazy(self):
        p = self.broken()
        p["parts"][0]["acceptance"] = "A9"
        self.assertIn("lazy:p", self.ids(p))

    def test_composition_without_justification(self):
        p = self.broken()
        p["composition"][0]["justification"] = " "
        self.assertIn("composition:K0", self.ids(p))

    def test_bad_strength(self):
        p = self.broken()
        p["slices"][0]["claims"][0]["strength"] = "likely"
        self.assertIn("strength:C1.1", self.ids(p))

    def test_assumed_needs_acceptance(self):
        p = self.broken()
        p["slices"][0]["claims"][0]["strength"] = "assumed"
        self.assertIn("assumed:C1.1", self.ids(p))
        p["accepted"] = ["assumed:C1.1"]
        self.assertEqual(set(), self.ids(p))

    def test_confluence_shared_file(self):
        p = self.broken()
        p["slices"][1]["files"] = ["a.py"]
        self.assertIn("confluence:S1-S2", self.ids(p))

    def test_confluence_write_read(self):
        p = self.broken()
        p["slices"][1]["effects"]["reads"] = ["out/a.json"]
        self.assertIn("confluence:S1-S2", self.ids(p))

    def test_done_missing_in_phase_2(self):
        p = self.broken()
        p["slices"][0]["pseudocode"][0]["done"] = ""
        self.assertIn("done:S1.line1", self.ids(p, phase=2))
        self.assertNotIn("done:S1.line1", self.ids(p, phase=1))

    def test_scenario_without_test(self):
        p = self.broken()
        p["slices"][0]["scenarios"] = ["SC9"]
        self.assertIn("scenario:SC9", self.ids(p))

    def test_extra_findings_merge_and_levels(self):
        extra = [
            {"id": "eta:f", "check": "eta", "level": "fail", "file": "", "line": 0, "detail": ""},
            {"id": "tool:ruff", "check": "tool", "level": "consider", "file": "", "line": 0, "detail": ""},
        ]
        found, blocking = verify_plan.verify(VALID, self.root, 2, extra)
        self.assertEqual(["eta:f"], [f["id"] for f in blocking])
        self.assertEqual(2, len(found))

    def test_main_exit_codes(self):
        path = self.root / "plan.json"
        path.write_text(json.dumps(VALID))
        argv = [str(path), "--root", str(self.root), "--phase", "2"]
        self.assertEqual(0, verify_plan.main(argv + ["--json"]))
        bad = self.broken()
        bad["parts"][0]["acceptance"] = "A9"
        path.write_text(json.dumps(bad))
        self.assertEqual(1, verify_plan.main(argv + ["--json"]))


if __name__ == "__main__":
    unittest.main()
