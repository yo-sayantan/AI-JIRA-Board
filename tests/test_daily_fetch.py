#!/usr/bin/env python3
"""daily_fetch.py pure helpers: update-log idempotence, identity matching, Bitbucket hints."""
import contextlib
import json
import os
import shutil
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "jira-intern"))
import daily_fetch  # noqa: E402
from _jira import status_column  # noqa: E402

CREATED = "2026-01-01T09:00:00.000+0000"
RESOLVED = "2026-02-01T09:00:00.000+0000"


def done_entries(log):
    return [e for e in log if (e.get("text") or "").startswith("Marked DONE")]


class UpdateLog(unittest.TestCase):
    def test_marked_done_is_idempotent_without_resolutiondate(self):
        first = daily_fetch.build_update_log("K-1", CREATED, "Done", None, None)
        self.assertEqual(len(done_entries(first)), 1)
        second = daily_fetch.build_update_log("K-1", CREATED, "Done", None, None, prior_log=first)
        third = daily_fetch.build_update_log("K-1", CREATED, "Done", None, None, prior_log=second)
        self.assertEqual(len(done_entries(second)), 1)
        self.assertEqual(len(done_entries(third)), 1)
        self.assertEqual(third[-1]["text"], "Opened")
        self.assertEqual(third[-1]["when"], "2026-01-01")

    def test_fresh_marked_done_wins_over_prior_with_other_day(self):
        prior = [{"when": "2026-01-20", "text": "Marked DONE — 2026-01-20"}, {"when": "2026-01-01", "text": "Opened"}]
        log = daily_fetch.build_update_log("K-1", CREATED, "Done", RESOLVED, None, prior_log=prior)
        done = done_entries(log)
        self.assertEqual(len(done), 1)
        self.assertEqual(done[0]["text"], "Marked DONE — 2026-02-01")
        self.assertEqual(done[0]["when"], "2026-02-01")

    def test_prior_assigned_entry_is_kept_once(self):
        prior = [{"when": "2026-01-01", "text": "Assigned — initial brief"}]
        log = daily_fetch.build_update_log("K-1", CREATED, "In Progress", None, None, prior_log=prior)
        log = daily_fetch.build_update_log("K-1", CREATED, "In Progress", None, None, prior_log=log)
        self.assertEqual(sum(1 for e in log if e["text"].startswith("Assigned")), 1)
        self.assertEqual(done_entries(log), [])

    def test_changelog_transitions_newest_first(self):
        changelog = {"histories": [
            {"created": "2026-01-03T10:00:00.000+0000", "items": [{"field": "status", "toString": "In Progress"}]},
            {"created": "2026-01-05T10:00:00.000+0000", "items": [{"field": "status", "toString": "In Review"}]},
        ]}
        log = daily_fetch.build_update_log("K-1", CREATED, "In Review", None, changelog)
        self.assertEqual([e["text"] for e in log], ["In Review", "In Progress", "Opened"])


class IsMine(unittest.TestCase):
    def setUp(self):
        for name, value in (("MY_ACCOUNT", "ABC123"), ("MY_EMAIL", "ME@EXAMPLE.COM")):
            p = mock.patch.object(daily_fetch, name, value)
            p.start()
            self.addCleanup(p.stop)

    def test_exact_identifier_match_case_insensitive(self):
        self.assertTrue(daily_fetch.is_mine({"name": "abc123"}))
        self.assertTrue(daily_fetch.is_mine({"key": "ABC123"}))
        self.assertTrue(daily_fetch.is_mine({"accountId": "abc123"}))
        self.assertTrue(daily_fetch.is_mine({"emailAddress": "me@example.com"}))

    def test_no_substring_match(self):
        self.assertFalse(daily_fetch.is_mine({"name": "ABC1234"}))
        self.assertFalse(daily_fetch.is_mine({"name": "XABC123"}))
        self.assertFalse(daily_fetch.is_mine({"displayName": "XABC123Y"}))
        self.assertFalse(daily_fetch.is_mine({"displayName": "ABC1234"}))

    def test_display_name_whole_word(self):
        self.assertTrue(daily_fetch.is_mine({"displayName": "Some One (ABC123)"}))
        self.assertTrue(daily_fetch.is_mine({"displayName": "abc123"}))

    def test_empty(self):
        self.assertFalse(daily_fetch.is_mine(None))
        self.assertFalse(daily_fetch.is_mine({}))
        with mock.patch.object(daily_fetch, "MY_ACCOUNT", ""):
            self.assertFalse(daily_fetch.is_mine({"name": "ABC123"}))


class StatusColumns(unittest.TestCase):
    def test_aliases(self):
        self.assertEqual(status_column("Won't Fix"), "done")
        self.assertEqual(status_column("Cancelled"), "done")
        self.assertEqual(status_column("canceled"), "done")
        self.assertEqual(status_column("Rejected"), "done")
        self.assertEqual(status_column("Blocked"), "blocked")
        self.assertEqual(status_column("On Hold"), "hold")
        self.assertEqual(status_column(None), "prog")


class BitbucketHints(unittest.TestCase):
    def test_no_hints_means_no_scan(self):
        def explode(*a, **k):
            raise AssertionError("Bitbucket must not be called without hints")

        with mock.patch.object(daily_fetch, "REPO_HINTS", {}), mock.patch.object(daily_fetch, "BB_PROJECT", {}), \
                mock.patch.object(daily_fetch, "bb_get", explode):
            self.assertEqual(daily_fetch.bb_search_all_prs("PROJ-1"), [])
        with mock.patch.object(daily_fetch, "REPO_HINTS", {"PROJ": ["r"]}), mock.patch.object(daily_fetch, "BB_PROJECT", {}), \
                mock.patch.object(daily_fetch, "bb_get", explode):
            self.assertEqual(daily_fetch.bb_search_all_prs("PROJ-1"), [])

    def test_pr_to_obj_without_project_has_no_url_but_has_updated_at(self):
        obj = daily_fetch.pr_to_obj({
            "id": 5, "state": "MERGED", "title": "t",
            "fromRef": {"displayId": "feature/PROJ-1_x", "repository": {"slug": "repo"}},
            "toRef": {"displayId": "develop"},
            "updatedDate": 1700000000000, "closedDate": 1700000000000,
        })
        self.assertEqual(obj["state"], "merged")
        self.assertIsNone(obj["url"])
        self.assertEqual(obj["updatedAt"], "2023-11-14T22:13:20Z")
        self.assertEqual(obj["mergedAt"], "2023-11-14T22:13:20Z")


def _issue(key, title, **extra):
    fields = {
        "summary": title, "status": {"name": "In Progress"}, "issuetype": {"name": "Task"},
        "created": CREATED, "updated": "2026-03-01T10:00:00.000+0000", "assignee": None,
    }
    fields.update(extra)
    return {"key": key, "id": key.split("-")[1], "fields": fields, "changelog": {"histories": []}}


class MainFlow(unittest.TestCase):
    """_main with Jira mocked: one bad payload must not kill the run; the prior card is kept."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="daily-test-")
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.data_path = os.path.join(self.tmp, "data.json")
        self.state_path = os.path.join(self.tmp, ".state.json")
        with open(self.data_path, "w", encoding="utf-8") as f:
            json.dump({"tickets": [
                {"key": "T-2", "title": "old T-2", "status": "In Progress", "column": "prog", "updateLog": [], "prs": [], "branches": []},
            ], "completed": [{"key": "C-1", "title": "archived"}]}, f)
        self.written, self.state = [], {}

        def fake_search(jql, **k):
            return [] if "parent in" in jql else list(self.issues)

        def bb_down(path, **k):
            raise OSError("bitbucket down")

        patches = [
            mock.patch.object(daily_fetch, "search_jira", fake_search),
            mock.patch.object(daily_fetch, "comments_for", lambda key, f: ([], 0, None)),
            mock.patch.object(daily_fetch, "_bb_get", bb_down),
            mock.patch.object(daily_fetch.devinfo, "fetch_many", lambda *a, **k: {}),
            mock.patch.object(daily_fetch, "write_outputs", lambda data, intern_dir=None: self.written.append(data)),
            mock.patch.object(daily_fetch, "atomic_dump", lambda path, obj: self.state.update(obj)),
            mock.patch.object(daily_fetch, "prepend_status", lambda *a, **k: None),
            mock.patch.object(daily_fetch, "set_progress", lambda *a, **k: None),
            mock.patch.object(daily_fetch, "data_lock", lambda *a, **k: contextlib.nullcontext()),
            mock.patch.dict(os.environ, {"JIRA_PERSONAL_TOKEN": "x"}),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)

    def test_bad_ticket_is_carried_forward_and_run_completes(self):
        # components: [None] makes build_ticket raise for T-2 only.
        self.issues = [_issue("T-1", "new T-1"), _issue("T-2", "new T-2", components=[None])]
        err = mock.MagicMock()
        with mock.patch.object(sys, "stderr", err):
            out, changes, notes = daily_fetch._main(self.data_path, self.state_path)
        by = {t["key"]: t for t in out["tickets"]}
        self.assertEqual(set(by), {"T-1", "T-2"})
        self.assertEqual(by["T-1"]["title"], "new T-1")
        self.assertEqual(by["T-2"]["title"], "old T-2")
        self.assertEqual(out["completed"], [{"key": "C-1", "title": "archived"}])
        self.assertTrue(any("Build failed" in n and "T-2" in n for n in notes))
        self.assertEqual(changes["new"], ["T-1: new T-1"])
        self.assertEqual(set(self.state), {"T-1", "T-2"})
        self.assertEqual(len(self.written), 1)
        warned = "".join(str(c.args[0]) for c in err.write.call_args_list)
        self.assertIn("WARN build T-2", warned)

    def test_every_ticket_failing_exits_nonzero_without_writing(self):
        self.issues = [_issue("T-1", "x", components=[None]), _issue("T-2", "y", components=[None])]
        with mock.patch.object(sys, "stderr", mock.MagicMock()), mock.patch.object(sys, "stdout", mock.MagicMock()):
            with self.assertRaises(SystemExit) as cm:
                daily_fetch._main(self.data_path, self.state_path)
        self.assertEqual(cm.exception.code, 1)
        self.assertEqual(self.written, [])

    def test_no_token_exits_2_after_restamping(self):
        with mock.patch.dict(os.environ, {"JIRA_PERSONAL_TOKEN": ""}), mock.patch.object(sys, "stdout", mock.MagicMock()):
            with self.assertRaises(SystemExit) as cm:
                daily_fetch._main(self.data_path, self.state_path)
        self.assertEqual(cm.exception.code, 2)
        self.assertEqual(len(self.written), 1)
        self.assertEqual([t["key"] for t in self.written[0]["tickets"]], ["T-2"])
        self.assertIn("no token", self.written[0]["notes"][0])


class RefreshOneKey(unittest.TestCase):
    def test_bad_key_is_refused(self):
        with mock.patch.object(daily_fetch, "load_env", lambda: None):
            with self.assertRaisesRegex(SystemExit, "bad key"):
                daily_fetch.refresh_one("PROJ-1; rm -rf /")
            with self.assertRaisesRegex(SystemExit, "bad key"):
                daily_fetch.refresh_one("../../etc/passwd")
            with self.assertRaisesRegex(SystemExit, "missing key"):
                daily_fetch.refresh_one("  ")


if __name__ == "__main__":
    unittest.main()
