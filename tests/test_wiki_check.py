"""Tests for wiki_check.py: each rule of the Checks table finds its broken case (C1.1)."""

import contextlib
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "core" / "verify"))
import wiki_check


def crlf_bom(text):
    return b"\xef\xbb\xbf" + text.replace("\n", "\r\n").encode()


def by_id(found):
    return {f["id"]: f["level"] for f in found}


def index_of(lines):
    return "# Wiki index\n" + "- [Alpha](alpha.md): the alpha page\n" * (lines - 1)


FRONT = "---\ntitle: Alpha\nupdated: 2026-02-14\nsource_commit: abc1234\ntags: [standards, gotcha]\n---\n\n"
PAGE = (
    FRONT + "## Summary\nAlpha does one thing.\n\n## Facts\n- It reads a file (`a.py:1`)\n\n"
    "## Decisions\n- Keep it flat: simple (2026-02-14)\n\n## Gotchas\n- Trap: fix\n"
)


def page_of(lines):
    return PAGE + "- Another trap: fix\n" * (lines - len(PAGE.splitlines()))


INDEX = "# Wiki index\n- [Alpha](alpha.md): the alpha page\n- [Beta](beta.md): the beta page\n"


class WikiCheckTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def wiki(self, files):
        for name, content in files.items():
            (self.root / name).write_bytes(content if isinstance(content, bytes) else content.encode())
        return self.root

    def check(self, files):
        return wiki_check.check_wiki(wiki_check.read_wiki(self.wiki(files)))

    def levels(self, files):
        return by_id(self.check(files))

    def run_main(self, *argv, path=None):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = wiki_check.main([str(path or self.root), *argv])
        return code, out.getvalue()

    def test_sc1_valid_wiki_is_clean(self):
        self.assertEqual([], self.check({"index.md": INDEX, "alpha.md": PAGE, "beta.md": PAGE}))
        code, out = self.run_main()
        self.assertEqual(0, code)
        self.assertEqual("0 finding(s), 0 fail\n", out)

    def test_sc1_crlf_and_bom_wiki_is_clean(self):
        files = {"index.md": crlf_bom(INDEX), "alpha.md": crlf_bom(PAGE), "beta.md": crlf_bom(PAGE)}
        self.assertEqual([], self.check(files))

    def test_sc2_wrong_heading_fails(self):
        found = wiki_check.check_index("# Index\n- [Alpha](alpha.md): the alpha page\n", {"alpha.md"})
        self.assertEqual({"index-heading": "fail"}, by_id(found))

    def test_sc2_empty_index_has_no_heading(self):
        self.assertEqual({"index-heading": "fail"}, by_id(wiki_check.check_index("", set())))

    def test_sc2_twenty_one_lines_fail_and_twenty_pass(self):
        self.assertEqual({"index-lines": "fail"}, by_id(wiki_check.check_index(index_of(21), {"alpha.md"})))
        self.assertEqual({}, by_id(wiki_check.check_index(index_of(20), {"alpha.md"})))

    def test_sc2_prose_line_is_consider(self):
        text = "# Wiki index\nSome prose here\n\n- [Alpha](alpha.md): the alpha page\n"
        self.assertEqual({"index-line:2": "consider"}, by_id(wiki_check.check_index(text, {"alpha.md"})))

    def test_sc2_line_without_a_summary_is_consider(self):
        text = "# Wiki index\n- [Alpha](alpha.md)\n"
        self.assertEqual({"index-line:2": "consider"}, by_id(wiki_check.check_index(text, set())))

    def test_sc2_check_wiki_reports_index_findings(self):
        levels = self.levels({"index.md": "# Index\n- [Alpha](alpha.md): the alpha page\n", "alpha.md": PAGE})
        self.assertEqual({"index-heading": "fail"}, levels)

    def test_sc3_folder_without_index_fails(self):
        self.assertEqual({"index:missing": "fail"}, self.levels({"alpha.md": PAGE}))
        code, out = self.run_main()
        self.assertEqual(1, code)
        self.assertIn("index:missing", out)

    def test_sc4_camel_case_and_snake_case_names_fail(self):
        names = ["Home.md", "my_page.md", "a-b2.md"]
        index = "# Wiki index\n" + "".join(f"- [T]({name}): about it\n" for name in names)
        levels = self.levels({"index.md": index, **{name: PAGE for name in names}})
        self.assertEqual({"name:Home.md": "fail", "name:my_page.md": "fail"}, levels)

    def page_ids(self, text):
        return by_id(wiki_check.check_page("alpha.md", text))

    def test_sc5_page_without_frontmatter_fails(self):
        self.assertEqual({"frontmatter:alpha.md": "fail"}, self.page_ids("## Summary\nAlpha.\n"))

    def test_sc5_unclosed_frontmatter_fails(self):
        self.assertEqual({"frontmatter:alpha.md": "fail"}, self.page_ids(PAGE.replace("---\n\n", "\n", 1)))

    def test_sc5_missing_or_empty_key_fails(self):
        self.assertEqual({"key:alpha.md:tags": "fail"}, self.page_ids(PAGE.replace("tags: [standards, gotcha]\n", "")))
        self.assertEqual({"key:alpha.md:title": "fail"}, self.page_ids(PAGE.replace("title: Alpha", "title:")))

    def test_sc5_impossible_date_fails(self):
        self.assertEqual({"updated:alpha.md": "fail"}, self.page_ids(PAGE.replace("2026-02-14\nsource", "2026-02-30\nsource")))
        self.assertEqual({"updated:alpha.md": "fail"}, self.page_ids(PAGE.replace("2026-02-14\nsource", "14-02-2026\nsource")))

    def test_sc5_bad_source_commit_fails(self):
        for bad in ("xyz", "abc123", "a" * 41):
            with self.subTest(bad=bad):
                self.assertEqual({"source-commit:alpha.md": "fail"}, self.page_ids(PAGE.replace("abc1234", bad)))
        for good in ("abc1234", "A" * 40):
            with self.subTest(good=good):
                self.assertEqual({}, self.page_ids(PAGE.replace("abc1234", good)))

    def test_sc5_bad_tags_fail(self):
        for bad in ("[standards, wiki]", "[wiki]", "standards", "[]"):
            with self.subTest(bad=bad):
                self.assertEqual({"tags:alpha.md": "fail"}, self.page_ids(PAGE.replace("[standards, gotcha]", bad)))
        self.assertEqual({}, self.page_ids(PAGE.replace("[standards, gotcha]", "[architecture]")))

    def test_sc6_unknown_section_fails(self):
        self.assertEqual({"section:alpha.md:11": "fail"}, self.page_ids(FRONT + "## Summary\nA.\n\n## Notes\nx\n"))

    def test_sc6_facts_before_summary_fails(self):
        body = "## Facts\n- f (`a.py:1`)\n\n## Summary\nA.\n"
        self.assertEqual({"section-order:alpha.md:11": "fail"}, self.page_ids(FRONT + body))

    def test_sc6_two_facts_sections_fail(self):
        body = "## Summary\nA.\n\n## Facts\n- f (`a.py:1`)\n\n## Facts\n- g (`a.py:2`)\n"
        self.assertEqual({"section-order:alpha.md:14": "fail"}, self.page_ids(FRONT + body))

    def test_sc6_heading_inside_code_fence_is_ignored(self):
        self.assertEqual({}, self.page_ids(FRONT + "## Summary\nA.\n\n```\n## Notes\n```\n"))
        self.assertEqual({}, self.page_ids(FRONT + "## Summary\nA.\n\n~~~md\n## Notes\n~~~\n"))

    def test_sc6_fence_closes_only_on_a_marker_of_the_same_kind_and_length(self):
        head = FRONT + "## Summary\nA.\n\n"
        self.assertEqual({}, self.page_ids(head + "````\n```\n## Notes\n````\n"))
        self.assertEqual({}, self.page_ids(head + "```\n~~~\n## Notes\n```\n"))
        self.assertEqual({}, self.page_ids(head + "```\n```x\n## Notes\n```\n"))

    def test_sc6_backtick_line_with_a_backtick_in_its_info_is_not_a_fence(self):
        body = "## Summary\nA.\n\n```x``` is inline code.\n\n## Notes\nx\n"
        self.assertEqual({"section:alpha.md:13": "fail"}, self.page_ids(FRONT + body))

    def test_sc7_eighty_one_lines_fail_and_eighty_pass(self):
        self.assertEqual({"page-lines:alpha.md": "fail"}, by_id(wiki_check.check_page("alpha.md", page_of(81))))
        self.assertEqual({}, by_id(wiki_check.check_page("alpha.md", page_of(80))))

    def test_sc8_uncited_fact_is_consider_and_exit_is_zero(self):
        body = (
            "## Summary\nA.\n\n## Facts\n- It does a thing\n- Another thing\n  (`a.py:3`)\n\n"
            "## Decisions\n- Chose x: reason (2026-02-14)\n"
        )
        page = FRONT + body
        self.assertEqual({"citation:alpha.md:12": "consider"}, self.page_ids(page))
        self.wiki({"index.md": "# Wiki index\n- [Alpha](alpha.md): the alpha page\n", "alpha.md": page})
        code, out = self.run_main()
        self.assertEqual(0, code)
        self.assertIn("consider  citation:alpha.md:12", out)

    def test_sc8_backticked_fact_without_a_line_number_is_consider(self):
        body = "## Facts\n- It reads `src/a.py`\n"
        self.assertEqual({"citation:alpha.md:12": "consider"}, self.page_ids(FRONT + "## Summary\nA.\n\n" + body))

    def test_sc8_a_blank_line_ends_the_fact_item(self):
        body = "## Summary\nA.\n\n## Facts\n- It does a thing\n\nSee `a.py:3`.\n"
        self.assertEqual({"citation:alpha.md:12": "consider"}, self.page_ids(FRONT + body))

    def test_sc9_dead_link_and_unlisted_page_fail(self):
        index = "# Wiki index\n- [Alpha](alpha.md): the alpha page\n- [Gone](gone.md): a gone page\n"
        levels = self.levels({"index.md": index, "alpha.md": PAGE, "extra.md": PAGE})
        self.assertEqual({"index-dead:gone.md": "fail", "index-absent:extra.md": "fail"}, levels)

    def two_findings(self):
        page = PAGE.replace("[standards, gotcha]", "[wiki]").replace(" (`a.py:1`)", "")
        self.wiki({"index.md": "# Wiki index\n- [Alpha](alpha.md): the alpha page\n", "alpha.md": page})

    def test_sc11_json_items_have_exactly_the_six_keys(self):
        self.two_findings()
        code, out = self.run_main("--json")
        self.assertEqual(1, code)
        items = json.loads(out)
        self.assertEqual(2, len(items))
        for item in items:
            self.assertEqual({"id", "check", "level", "file", "line", "detail"}, set(item))

    def test_sc11_text_output_ends_with_the_count_line(self):
        self.two_findings()
        code, out = self.run_main()
        self.assertEqual(1, code)
        self.assertIn("fail      tags:alpha.md  alpha.md:5  ", out)
        self.assertIn("consider  citation:alpha.md:12  alpha.md:12  ", out)
        self.assertEqual("2 finding(s), 1 fail", out.splitlines()[-1])

    def test_sc11_text_output_survives_a_non_utf8_stdout(self):
        page = FRONT + "## Summary\nA.\n\n## A → B\nx\n"
        self.wiki({"index.md": "# Wiki index\n- [Alpha](alpha.md): the alpha page\n", "alpha.md": page})
        out = io.TextIOWrapper(io.BytesIO(), encoding="cp1252")
        with contextlib.redirect_stdout(out):
            code = wiki_check.main([str(self.root)])
        out.flush()
        self.assertEqual(1, code)
        self.assertEqual("1 finding(s), 1 fail", out.buffer.getvalue().decode("ascii").splitlines()[-1])

    def test_sc10_path_that_is_not_a_directory_is_not_run(self):
        missing = self.root / "gone"
        found = wiki_check.check_wiki(wiki_check.read_wiki(missing))
        self.assertEqual({"wiki:unread": "not-run"}, by_id(found))
        code, out = self.run_main(path=missing)
        self.assertEqual(0, code)
        self.assertIn("wiki:unread", out)

    def test_sc10_page_that_is_not_utf8_is_not_run(self):
        levels = self.levels({"index.md": INDEX, "alpha.md": b"\xff\xfe\xfa", "beta.md": PAGE})
        self.assertEqual({"unread:alpha.md": "not-run"}, levels)
        code, out = self.run_main()
        self.assertEqual(0, code)
        self.assertIn("unread:alpha.md", out)

    def test_sc10_directory_that_cannot_be_listed_is_not_run(self):
        with mock.patch.object(Path, "iterdir", side_effect=PermissionError):
            found = wiki_check.check_wiki(wiki_check.read_wiki(self.root))
            self.assertEqual({"wiki:unread": "not-run"}, by_id(found))
            code, out = self.run_main()
        self.assertEqual(0, code)
        self.assertIn("wiki:unread", out)

    def test_sc10_file_that_cannot_be_read_is_not_run(self):
        real = Path.read_bytes

        def read_bytes(path):
            if path.name == "alpha.md":
                raise OSError
            return real(path)

        self.wiki({"index.md": INDEX, "alpha.md": PAGE, "beta.md": PAGE})
        with mock.patch.object(Path, "read_bytes", read_bytes):
            found = wiki_check.check_wiki(wiki_check.read_wiki(self.root))
        self.assertEqual({"unread:alpha.md": "not-run"}, by_id(found))

    def test_sc10_index_that_is_not_utf8_is_not_run(self):
        levels = self.levels({"index.md": b"\xff\xfe\xfa", "alpha.md": PAGE})
        self.assertEqual({"unread:index.md": "not-run"}, levels)


if __name__ == "__main__":
    unittest.main()
