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
            "claims": [{"id": "C1.1", "strength": "tested", "evidence": "tests/test_a.py:1"}],
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
        own, _ = verify_plan.verify(VALID, self.root, 2)
        found, blocking = verify_plan.verify(VALID, self.root, 2, extra)
        self.assertEqual(["eta:f"], [f["id"] for f in blocking])
        self.assertEqual(len(own) + 2, len(found))

    def test_main_exit_codes(self):
        path = self.root / "plan.json"
        path.write_text(json.dumps(VALID))
        argv = [str(path), "--root", str(self.root), "--phase", "2"]
        self.assertEqual(0, verify_plan.main(argv + ["--json"]))
        bad = self.broken()
        bad["parts"][0]["acceptance"] = "A9"
        path.write_text(json.dumps(bad))
        self.assertEqual(1, verify_plan.main(argv + ["--json"]))


class ReviewRegressionTests(VerifyPlanTests):
    def test_scenario_needs_whole_id(self):
        (self.root / "tests" / "test_a.py").write_text("def test_SC10(): pass\n")
        self.assertIn("scenario:SC1", self.ids(VALID))

    def test_scenario_ignores_venv(self):
        venv = self.root / ".venv" / "Lib" / "site-packages"
        venv.mkdir(parents=True)
        (venv / "test_x.py").write_text("def test_SC2(): pass\n")
        p = self.broken()
        p["slices"][0]["scenarios"] = ["SC2"]
        self.assertIn("scenario:SC2", self.ids(p))

    def test_jest_test_name(self):
        (self.root / "tests" / "a.test.js").write_text("test('SC3 returns a name', () => {});\n")
        p = self.broken()
        p["slices"][0]["scenarios"] = ["SC3"]
        self.assertEqual(set(), self.ids(p))

    def test_phase_1_skips_planned_evidence(self):
        p = self.broken()
        p["slices"][0]["claims"][0]["evidence"] = "tests/test_new.py:3"
        self.assertEqual(set(), self.ids(p, phase=1))
        self.assertIn("ref:C1.1:tests/test_new.py:3", self.ids(p, phase=2))

    def test_line_bounds(self):
        p = self.broken()
        p["composition"][0]["justification"] = "a.py:3"
        self.assertIn("ref:K0:a.py:3", self.ids(p))
        p["composition"][0]["justification"] = "a.py:0"
        self.assertIn("ref:K0:a.py:0", self.ids(p))

    def test_drive_path_ref(self):
        p = self.broken()
        p["composition"][0]["justification"] = "E:/nowhere/z.py:9"
        self.assertIn("ref:K0:E:/nowhere/z.py:9", self.ids(p))

    def test_unknown_parallel_slice(self):
        p = self.broken()
        p["slices"][1]["parallel"] = ["S9"]
        self.assertIn("confluence:S2-S9", self.ids(p))

    def test_missing_key_is_a_finding(self):
        p = self.broken()
        del p["slices"][0]["claims"][0]["id"]
        self.assertIn("schema:claims[0].id", self.ids(p))

    def test_url_with_port_is_not_a_ref(self):
        p = self.broken()
        p["composition"][0]["justification"] = "spec at https://example.invalid:8443/x and a.py:1"
        self.assertEqual(set(), self.ids(p))

    def test_more_test_name_forms(self):
        (self.root / "tests" / "test_b.py").write_text("class TestSC4:\n    def test_ok(self): pass\n\ndef test_sc5_lower(): pass\n")
        (self.root / "tests" / "b.test.js").write_text("test.each([[1]])('SC6 case %s', () => {});\nit.only('SC7', () => {});\n")
        p = self.broken()
        p["slices"][0]["scenarios"] = ["SC4", "SC5", "SC6", "SC7"]
        self.assertEqual(set(), self.ids(p))

    def test_bad_types_are_findings(self):
        p = self.broken()
        p["parts"] = [{"name": "p", "acceptance": ["A1"]}]
        self.assertIn("schema:parts[0].acceptance", self.ids(p))
        p = self.broken()
        p["composition"][0]["justification"] = 5
        p["slices"][0]["scenarios"] = "SC1"
        p["slices"][2]["depends"] = "S10"
        ids = self.ids(p)
        for fid in ("schema:composition[0].justification", "schema:slices[0].scenarios", "schema:slices[2].depends"):
            self.assertIn(fid, ids)
        p = self.broken()
        p["slices"][0]["effects"] = {"writes": "a.py"}
        p["slices"][1]["effects"] = ["x"]
        p["accepted"] = [1]
        ids = self.ids(p)
        for fid in ("schema:slices[0].effects", "schema:slices[1].effects", "schema:accepted"):
            self.assertIn(fid, ids)
        found, blocking = verify_plan.verify([], self.root, 1)
        self.assertEqual(["schema:top"], [f["id"] for f in blocking])

    def test_utf16_findings(self):
        path = self.root / "plan.json"
        path.write_text(json.dumps(VALID))
        extra = self.root / "f.json"
        extra.write_text("[]", encoding="utf-16")
        argv = [str(path), "--root", str(self.root), "--phase", "2", "--json", "--findings", str(extra)]
        self.assertEqual(0, verify_plan.main(argv))

    def test_bom_files(self):
        path = self.root / "plan.json"
        path.write_text(json.dumps(VALID), encoding="utf-8-sig")
        extra = self.root / "f.json"
        extra.write_text("[]", encoding="utf-8-sig")
        argv = [str(path), "--root", str(self.root), "--phase", "2", "--json", "--findings", str(extra)]
        self.assertEqual(0, verify_plan.main(argv))


class GraphTests(VerifyPlanTests):
    def levels(self, plan, phase=2):
        found, _ = verify_plan.verify(plan, self.root, phase)
        return {f["id"]: f["level"] for f in found}

    def test_depends_cycle(self):
        p = self.broken()
        p["slices"][0]["depends"] = ["S3"]
        ids = self.ids(p)
        self.assertIn("cycle:S1-S3", ids)
        self.assertNotIn("order:S1", ids)

    def test_self_dependency_is_a_cycle(self):
        p = self.broken()
        p["slices"][1]["depends"] = ["S2"]
        self.assertIn("cycle:S2", self.ids(p))

    def test_unknown_depends(self):
        p = self.broken()
        p["slices"][2]["depends"] = ["S1", "S9"]
        self.assertIn("depends:S3-S9", self.ids(p))

    def test_duplicate_ids(self):
        p = self.broken()
        p["slices"][1]["id"] = "S1"
        p["slices"][1]["parallel"] = []
        p["slices"][0]["parallel"] = []
        p["slices"][1]["claims"] = [{"id": "C1.1", "strength": "tested", "evidence": "tests/test_a.py:1"}]
        ids = self.ids(p)
        self.assertIn("duplicate:slice:S1", ids)
        self.assertIn("duplicate:claim:C1.1", ids)

    def test_file_in_two_slices(self):
        p = self.broken()
        p["slices"][2]["files"] = ["c.py", "a.py"]
        self.assertIn("owner:a.py", self.ids(p))

    def test_parallel_slices_must_not_depend(self):
        p = self.broken()
        p["slices"][1]["depends"] = ["S3"]
        self.assertIn("parallel-depends:S1-S2", self.ids(p))

    def test_one_sided_parallel(self):
        p = self.broken()
        p["slices"][1]["parallel"] = []
        self.assertIn("parallel-pair:S1-S2", self.ids(p))

    def test_slice_order(self):
        p = self.broken()
        p["slices"] = [p["slices"][2], p["slices"][0], p["slices"][1]]
        self.assertIn("order:S3", self.ids(p))

    def test_unused_output_is_a_note(self):
        levels = self.levels(VALID)
        self.assertEqual("consider", levels.get("unused:S2.z"))
        self.assertNotIn("unused:S1.y", levels)

    def test_acceptance_without_part(self):
        p = self.broken()
        p["acceptance"] = ["A1", "A2"]
        self.assertIn("uncovered:A2", self.ids(p))
        p["parts"] = []
        self.assertNotIn("uncovered:A2", self.ids(p))

    def test_stale_acceptance_is_a_note(self):
        p = self.broken()
        p["accepted"] = ["lazy:gone", "C1.1"]
        levels = self.levels(p)
        self.assertEqual("consider", levels.get("stale:lazy:gone"))
        self.assertNotIn("stale:C1.1", levels)

    def test_tested_claim_needs_a_test_file(self):
        p = self.broken()
        p["slices"][0]["claims"][0]["evidence"] = "a.py:2"
        self.assertIn("evidence:C1.1", self.ids(p, phase=2))
        self.assertNotIn("evidence:C1.1", self.ids(p, phase=1))

    def test_proved_claim_needs_evidence(self):
        p = self.broken()
        p["slices"][0]["claims"][0].update(strength="proved", evidence=" ")
        self.assertIn("evidence:C1.1", self.ids(p, phase=2))
        p["slices"][0]["claims"][0]["evidence"] = "induction on len(rows), a.py:1"
        self.assertEqual(set(), self.ids(p, phase=2))

    def test_test_file_forms_count_as_evidence(self):
        for evidence in ("tests/test_a.py::test_sc1", "pkg/x_test.go:1", "tests/helpers.py:1", "web/x.spec.ts:2", "t/x_test.py:3"):
            p = self.broken()
            p["slices"][0]["claims"][0]["evidence"] = evidence
            self.assertNotIn("evidence:C1.1", self.ids(p, phase=2), evidence)

    def test_node_id_parameters_are_not_refs(self):
        for evidence in ("tests/test_a.py::test_x[1:2]", "tests/test_a.py::test_x[a:1]", "tests/test_a.py::TestK::test_x[3:4,5:6]"):
            p = self.broken()
            p["slices"][0]["claims"][0]["evidence"] = evidence
            self.assertEqual(set(), self.ids(p, phase=2), evidence)

    def test_nested_brackets_in_node_id_parameters(self):
        for evidence in ("tests/test_a.py::test_x[d[k]v:2]", "tests/test_a.py::test_x[[1, 2]-x:3]"):
            p = self.broken()
            p["slices"][0]["claims"][0]["evidence"] = evidence
            self.assertEqual(set(), self.ids(p, phase=2), evidence)

    def test_node_id_prose_in_other_fields_is_not_checked(self):
        p = self.broken()
        p["composition"][0]["justification"] = "calls obj.attr::method, see pyproject.toml::tool.ruff and a.py:1"
        self.assertEqual(set(), self.ids(p, phase=1))
        self.assertEqual(set(), self.ids(p, phase=2))

    def test_wrapped_node_id_resolves_to_its_file(self):
        for evidence in ("`tests/test_a.py::test_x`", '"tests/test_a.py::test_x"', "'tests/test_a.py::test_x'", "[tests/test_a.py::test_x]"):
            p = self.broken()
            p["slices"][0]["claims"][0]["evidence"] = evidence
            self.assertEqual(set(), self.ids(p, phase=2), evidence)

    def test_node_id_file_must_exist(self):
        p = self.broken()
        p["slices"][0]["claims"][0]["evidence"] = "tests/test_nothere.py::test_x"
        self.assertIn("ref:C1.1:tests/test_nothere.py::test_x", self.ids(p, phase=2))
        p["slices"][0]["claims"][0]["evidence"] = "tests/test_a.py::test_x"
        self.assertEqual(set(), self.ids(p, phase=2))

    def test_blank_file_entries_have_no_owner(self):
        p = self.broken()
        p["slices"][1]["files"] = ["b.py", ""]
        p["slices"][2]["files"] = ["c.py", "", " "]
        p["slices"][0]["files"] = ["a.py", " "]
        self.assertEqual(set(), {i for i in self.ids(p) if i.startswith("owner:")})

    def test_inline_test_is_not_test_file_evidence(self):
        p = self.broken()
        p["slices"][0]["claims"][0]["evidence"] = "src/lib.rs:1"
        self.assertIn("evidence:C1.1", self.ids(p, phase=2))

    def test_two_loops_sharing_a_slice_are_one_cycle(self):
        p = self.broken()
        p["slices"][0]["depends"] = ["S2"]
        p["slices"][1]["depends"] = ["S1", "S3"]
        p["slices"][2]["depends"] = ["S2"]
        cycles = {i for i in self.ids(p) if i.startswith("cycle:")}
        self.assertEqual({"cycle:S1-S2-S3"}, cycles)

    def test_slice_leading_into_a_loop_is_not_in_it(self):
        p = self.broken()
        p["slices"][0]["depends"] = ["S2"]
        p["slices"][1]["depends"] = ["S1"]
        cycles = {i for i in self.ids(p) if i.startswith("cycle:")}
        self.assertEqual({"cycle:S1-S2"}, cycles)

    def test_direct_parallel_dependency(self):
        p = self.broken()
        p["slices"][1]["depends"] = ["S1"]
        self.assertIn("parallel-depends:S1-S2", self.ids(p))

    def test_stale_sees_extra_findings(self):
        p = self.broken()
        p["accepted"] = ["tool:ruff", "tool:nope"]
        extra = [{"id": "tool:ruff", "check": "tool", "level": "consider", "file": "", "line": 0, "detail": ""}]
        found, _ = verify_plan.verify(p, self.root, 2, extra)
        levels = {f["id"]: f["level"] for f in found}
        self.assertEqual("consider", levels.get("stale:tool:nope"))
        self.assertNotIn("stale:tool:ruff", levels)

    def test_int_ids_in_parallel(self):
        p = self.broken()
        p["slices"][0].update(id=1, parallel=["2"])
        p["slices"][1].update(id=2, parallel=["1"])
        p["slices"][2].update(depends=[], inputs=[])
        self.assertEqual(set(), {i for i in self.ids(p) if i.startswith("confluence:")})

    def test_int_claim_id_can_be_accepted_by_text(self):
        p = self.broken()
        p["slices"][0]["claims"] = [{"id": 5, "strength": "assumed", "evidence": ""}]
        p["accepted"] = ["5"]
        self.assertNotIn("assumed:5", self.ids(p))

    def test_int_ids_in_the_graph(self):
        p = self.broken()
        p["slices"][0].update(id=1, depends=["2"], parallel=[])
        p["slices"][1].update(id=2, depends=["1"], parallel=[])
        p["slices"][2].update(depends=[], inputs=[])
        self.assertIn("cycle:1-2", self.ids(p))

    def test_repeated_names_give_one_finding(self):
        p = self.broken()
        p["slices"][1]["outputs"] = ["z", "z"]
        p["acceptance"] = ["A1", "A2", "A2"]
        found, _ = verify_plan.verify(p, self.root, 2)
        ids = [f["id"] for f in found]
        self.assertEqual(1, ids.count("unused:S2.z"))
        self.assertEqual(1, ids.count("uncovered:A2"))

    def test_owner_ignores_path_spelling(self):
        p = self.broken()
        p["slices"][2]["files"] = ["c.py", "./a.py", "sub\\d.py"]
        p["slices"][1]["files"] = ["b.py", "sub/d.py"]
        ids = self.ids(p)
        self.assertIn("owner:a.py", ids)
        self.assertIn("owner:sub/d.py", ids)


if __name__ == "__main__":
    unittest.main()
