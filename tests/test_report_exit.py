#!/usr/bin/env python3
"""pr_report.py base: each reason a report is not produced has its own exit code, which the board
turns into a plain-language message (src/lib/reportFailure.ts keeps the numbers in sync)."""
import contextlib
import io
import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "jira-intern"))
import pr_report  # noqa: E402


class BaseExitCodes(unittest.TestCase):
    def _base(self, tickets):
        data = {"tickets": tickets, "completed": []}
        err = io.StringIO()
        with mock.patch.object(pr_report, "load_data", return_value=data), contextlib.redirect_stderr(err):
            code = pr_report.main(["pr_report.py", "base", "ABC-1"])
        return code, err.getvalue()

    def test_constants_match_the_board(self):
        self.assertEqual((pr_report.EXIT_NOT_IN_DATA, pr_report.EXIT_NO_PR), (3, 4))

    def test_ticket_missing_from_the_data(self):
        code, err = self._base([])
        self.assertEqual(code, 3)
        self.assertIn("not in data.json", err)

    def test_ticket_without_a_pull_request(self):
        code, err = self._base([{"key": "ABC-1", "title": "t", "status": "Done", "prs": [], "pr": {"state": "none"}}])
        self.assertEqual(code, 4)
        self.assertIn("no pull request", err)


if __name__ == "__main__":
    unittest.main()
