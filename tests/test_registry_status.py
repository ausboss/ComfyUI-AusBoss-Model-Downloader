"""Publication checks must not mistake cached list responses for approval or absence."""

import contextlib
import importlib.util
import io
from pathlib import Path
import sys
import unittest
from unittest.mock import patch
import urllib.error


@unittest.skipIf(sys.version_info < (3, 11), "Release tools run on Python 3.12")
class RegistryStatusTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        path = Path(__file__).resolve().parent.parent / "scripts/registry_status.py"
        spec = importlib.util.spec_from_file_location("registry_status", path)
        cls.status = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.status)

    def entry(self, status):
        return {"node_id": self.status.NODE_ID, "version": "0.1.0", "status": status}

    def run_check(self, responses, args=()):
        output = io.StringIO()
        with patch.object(self.status, "fetch_json", side_effect=responses), \
                patch.object(sys, "argv", ["status", "--version", "0.1.0", *args]), \
                patch.dict("os.environ", {"GITHUB_STEP_SUMMARY": ""}), \
                contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
            result = self.status.main()
        return result, output.getvalue()

    def test_pending_not_missing_when_list_is_empty(self):
        result, output = self.run_check([self.entry("NodeVersionStatusPending"), []])
        self.assertEqual(result, 2)
        self.assertIn("NodeVersionStatusPending", output)
        self.assertNotIn("NotPublished", output)

    def test_existing_pending_version_cannot_be_published_again(self):
        result, _ = self.run_check([self.entry("NodeVersionStatusPending"), []], ["--require-unpublished"])
        self.assertEqual(result, 2)

    def test_stale_list_cannot_claim_approval(self):
        result, output = self.run_check([
            self.entry("NodeVersionStatusFlagged"), [self.entry("NodeVersionStatusActive")],
        ])
        self.assertEqual(result, 2)
        self.assertIn("Flagged for review", output)

    def test_active_status_uses_exact_version(self):
        result, _ = self.run_check([self.entry("NodeVersionStatusActive"), []])
        self.assertEqual(result, 0)

    def test_only_404_means_unpublished(self):
        for code, expected in [(404, 0), (403, 1), (500, 1)]:
            with self.subTest(code=code):
                error = urllib.error.HTTPError("https://api.comfy.org", code, "", {}, None)
                result, _ = self.run_check([error], ["--require-unpublished"])
                self.assertEqual(result, expected)

    def test_wrong_node_or_version_cannot_claim_approval(self):
        for field, value in [("node_id", "unrelated-pack"), ("version", "0.2.0")]:
            with self.subTest(field=field):
                entry = self.entry("NodeVersionStatusActive")
                entry[field] = value
                result, _ = self.run_check([entry])
                self.assertEqual(result, 1)

    def test_detailed_reason_requires_matching_status(self):
        listed = self.entry("NodeVersionStatusFlagged") | {"status_reason": "Example finding"}
        result, output = self.run_check([self.entry("NodeVersionStatusFlagged"), [listed]], ["--report"])
        self.assertEqual(result, 0)
        self.assertIn("Reason: Example finding", output)
        _, output = self.run_check([self.entry("NodeVersionStatusActive"), [listed]])
        self.assertNotIn("Example finding", output)


if __name__ == "__main__":
    unittest.main()
