"""Self-tests for ste_check.py. Run with: python test_ste_check.py"""

from __future__ import annotations

import contextlib
import io
import tempfile
import unittest
from pathlib import Path

import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "core" / "ste"))
import ste_check


class CheckTextTests(unittest.TestCase):
    """Each check fires on a constructed violation."""

    def codes(self, text: str, limit: int = 25) -> list[str]:
        return [str(item["code"]) for item in ste_check.check_text("t.md", text, limit)]

    def test_long_sentence(self) -> None:
        sentence = "The tool reads the file and then it counts every single word in the sentence and reports the total count to you at the end of the run."
        self.assertIn("LONG_SENTENCE", self.codes(sentence))

    def test_short_sentence_is_clean(self) -> None:
        self.assertEqual([], self.codes("Read the file. Count the words."))

    def test_limit_is_configurable(self) -> None:
        text = "The tool reads the file and reports the count."
        self.assertEqual([], self.codes(text, 25))
        self.assertIn("LONG_SENTENCE", self.codes(text, 5))

    def test_hedge(self) -> None:
        self.assertIn("HEDGE", self.codes("You should check the log."))

    def test_quoted_hedge_is_ignored(self) -> None:
        self.assertNotIn("HEDGE", self.codes('Saying "it is probably X" is a red flag.'))

    def test_unquoted_hedge_still_fires(self) -> None:
        self.assertIn("HEDGE", self.codes("It is probably X."))

    def test_existential(self) -> None:
        self.assertIn("EXISTENTIAL", self.codes("There are three files here."))

    def test_contraction(self) -> None:
        self.assertIn("CONTRACTION", self.codes("It's done."))

    def test_possessive_is_not_a_contraction(self) -> None:
        self.assertNotIn("CONTRACTION", self.codes("Read the user's note."))

    def test_passive(self) -> None:
        self.assertIn("PASSIVE", self.codes("The report was written by the tool."))

    def test_long_paragraph(self) -> None:
        text = "One. Two. Three. Four. Five. Six. Seven."
        self.assertIn("LONG_PARAGRAPH", self.codes(text))

    def test_paragraph_at_the_limit_is_clean(self) -> None:
        text = "One. Two. Three. Four. Five. Six."
        self.assertNotIn("LONG_PARAGRAPH", self.codes(text))


class ProseExtractionTests(unittest.TestCase):
    """Code, tables, headings, and frontmatter stay out of the check."""

    def codes(self, text: str) -> list[str]:
        return [str(item["code"]) for item in ste_check.check_text("t.md", text)]

    def test_frontmatter_is_skipped(self) -> None:
        text = "---\ndescription: There are no checks here and it's fine\n---\n\nClean text."
        self.assertEqual([], self.codes(text))

    def test_fenced_code_is_skipped(self) -> None:
        text = "Clean text.\n\n```python\n# There are 7 things and it's fine\n```\n"
        self.assertEqual([], self.codes(text))

    def test_table_rows_are_skipped(self) -> None:
        self.assertEqual([], self.codes("| a | There are things |\n|---|---|\n| 1 | it's |"))

    def test_headings_are_skipped(self) -> None:
        self.assertEqual([], self.codes("## There are no findings here"))

    def test_inline_code_counts_as_one_token(self) -> None:
        text = "Use `a very long inline code span that would otherwise blow the limit` here."
        self.assertEqual([], self.codes(text))

    def test_wrapped_lines_join_into_one_paragraph(self) -> None:
        text = (
            "The tool reads a file\n"
            "and then it counts every single word in that file\n"
            "and prints the total count for you at the very end of the run."
        )
        codes = self.codes(text)
        self.assertIn("LONG_SENTENCE", codes)

    def test_list_items_are_separate_units(self) -> None:
        text = "- One thing here.\n- Another thing here."
        self.assertEqual([], self.codes(text))


class CommandLineTests(unittest.TestCase):
    """Exit status and output contract."""

    def run_main(self, argv: list[str]) -> tuple[int, str]:
        buffer = io.StringIO()
        with contextlib.redirect_stdout(buffer):
            status = ste_check.main(argv)
        return status, buffer.getvalue()

    def write(self, text: str) -> Path:
        handle = tempfile.NamedTemporaryFile("w", suffix=".md", delete=False, encoding="utf-8")
        handle.write(text)
        handle.close()
        return Path(handle.name)

    def test_clean_file_exits_zero(self) -> None:
        path = self.write("Read the file. Count the words.\n")
        status, _ = self.run_main([str(path)])
        self.assertEqual(0, status)
        path.unlink()

    def test_findings_exit_one(self) -> None:
        path = self.write("You should probably rewrite it's wording.\n")
        status, _ = self.run_main([str(path)])
        self.assertEqual(1, status)
        path.unlink()

    def test_missing_file_exits_two(self) -> None:
        status, _ = self.run_main([str(Path(tempfile.gettempdir()) / "no-such-file-xyz.md")])
        self.assertEqual(2, status)

    def test_json_shape(self) -> None:
        path = self.write("It's here.\n")
        status, output = self.run_main([str(path), "--json"])
        payload = ste_check.json.loads(output)
        self.assertEqual(1, status)
        self.assertFalse(payload["ok"])
        self.assertEqual(payload["count"], len(payload["findings"]))
        self.assertIn("code", payload["findings"][0])
        path.unlink()

    def test_only_filter(self) -> None:
        path = self.write("It's here. You should look.\n")
        _, output = self.run_main([str(path), "--only", "CONTRACTION"])
        self.assertIn("CONTRACTION", output)
        self.assertNotIn("HEDGE", output)
        path.unlink()

    def test_skip_filter(self) -> None:
        path = self.write("It's here.\n")
        status, output = self.run_main([str(path), "--skip", "CONTRACTION"])
        self.assertEqual(0, status)
        self.assertIn("clean", output)
        path.unlink()


if __name__ == "__main__":
    unittest.main(verbosity=2)
