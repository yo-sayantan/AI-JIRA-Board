"""Primary branch / primary PR selection (devinfo.py): the ticket's branch is the one with the
newest commit, and the PR banners follow that branch's own PR. No network: Jira and Bitbucket
are replaced by canned payloads shaped like the real responses."""
import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "jira-intern"))

import devinfo  # noqa: E402

REPO = "https://code.example/projects/PROJ/repos/svc"
PLAIN = "feature/PROJ-1"
MID = "feature/PROJ-1_do_the_thing"
NEWEST = "feature/PROJ-1_do_the_thing_1"


def _branch(name):
    return {
        "name": name,
        "url": f"{REPO}/commits?until=refs%2Fheads%2F{name.replace('/', '%2F')}",
        "repository": {"name": "svc", "url": f"{REPO}/browse"},
    }


def _dev_status(prs=()):
    return {"detail": [{"branches": [_branch(PLAIN), _branch(MID), _branch(NEWEST)], "pullRequests": list(prs)}]}


def _dev_pr(pid, branch, status="OPEN", updated="2026-10-07T13:39:55.022+0000"):
    return {
        "id": f"#{pid}",
        "name": f"PROJ-1: change {pid}",
        "status": status,
        "url": f"{REPO}/pull-requests/{pid}",
        "source": {"branch": branch, "repository": {"name": "svc"}},
        "destination": {"branch": "release/x"},
        "reviewers": [{"name": "A", "approved": True}, {"name": "B", "approved": True}],
        "author": {"name": "Me"},
        "lastUpdate": updated,
    }


def _commit(ms):
    return {"values": [{"authorTimestamp": ms - 5000, "committerTimestamp": ms}]}


def _bb_router(commit_ms, outgoing=None):
    """A bb_get stand-in: newest-commit times per branch, optional PRs per branch."""
    calls = []

    def bb_get(path, timeout=45):
        calls.append(path)
        if "/commits?" in path:
            for name, ms in commit_ms.items():
                if f"until=refs%2Fheads%2F{name.replace('/', '%2F')}&" in path:  # exact value, not a prefix
                    if ms is None:
                        raise RuntimeError("404 branch gone")
                    return _commit(ms)
            raise RuntimeError("unknown branch")
        if "/pull-requests?" in path and "direction=OUTGOING" in path:
            for name, values in (outgoing or {}).items():
                if f"at=refs%2Fheads%2F{name.replace('/', '%2F')}&" in path:
                    return {"values": values}
            return {"values": []}
        return {"values": []}  # comment-stat / reviewer lookups on open PRs

    bb_get.calls = calls
    return bb_get


class ChoosePrimaryTests(unittest.TestCase):
    def setUp(self):
        self.pr_plain = {"state": "approved", "id": 61, "sourceBranch": PLAIN, "updatedAt": "2026-10-07T13:39:55Z"}
        self.pr_other = {"state": "comments", "id": 62, "sourceBranch": MID, "updatedAt": "2026-10-01T00:00:00Z"}

    def test_newest_commit_wins_and_its_pr_is_the_primary(self):
        branch, pr, branches, prs = devinfo.choose_primary(
            [PLAIN, MID, NEWEST], [self.pr_plain, self.pr_other], {PLAIN: 100, MID: 200, NEWEST: 300}
        )
        self.assertEqual(branch, NEWEST)
        self.assertEqual(pr, {"state": "none"})  # the newest branch has no PR of its own
        self.assertEqual(branches, [NEWEST, PLAIN, MID])
        self.assertEqual(sorted(p["id"] for p in prs), [61, 62])  # nothing is dropped

    def test_primary_pr_comes_from_the_chosen_branch_only(self):
        branch, pr, _b, prs = devinfo.choose_primary([PLAIN, MID], [self.pr_plain, self.pr_other], {PLAIN: 100, MID: 200})
        self.assertEqual((branch, pr["id"]), (MID, 62))
        self.assertEqual([p["id"] for p in prs], [62, 61])  # chosen branch's PRs first

    def test_branches_without_a_time_never_win(self):
        branch, *_ = devinfo.choose_primary([PLAIN, MID, NEWEST], [], {MID: 50})
        self.assertEqual(branch, MID)

    def test_prior_branch_holds_when_no_commit_time_was_read(self):
        branch, pr, *_ = devinfo.choose_primary([PLAIN, MID], [self.pr_plain], {}, prior_branch=MID)
        self.assertEqual(branch, MID)
        self.assertEqual(pr, {"state": "none"})

    def test_without_times_or_prior_the_old_rule_applies(self):
        branch, pr, *_ = devinfo.choose_primary([PLAIN, MID], [self.pr_plain, self.pr_other], {})
        self.assertEqual((branch, pr["id"]), (PLAIN, 61))  # first open PR decides, as before

    def test_one_branch_never_needs_times(self):
        branch, pr, branches, prs = devinfo.choose_primary([PLAIN], [self.pr_plain])
        self.assertEqual((branch, pr["id"], branches), (PLAIN, 61, [PLAIN]))
        self.assertEqual(prs, [self.pr_plain])

    def test_legacy_pick_survives_a_pr_without_a_source_branch(self):
        orphan = {"state": "approved", "id": 7, "sourceBranch": None}
        branch, pr, *_ = devinfo.choose_primary([MID], [orphan])
        self.assertEqual((branch, pr["id"]), (MID, 7))

    def test_nothing_at_all(self):
        self.assertEqual(devinfo.choose_primary([], []), (None, {"state": "none"}, [], []))

    def test_branch_names_compare_case_insensitively(self):
        pr = {"state": "approved", "id": 1, "sourceBranch": "Feature/PROJ-1"}
        _b, got, *_ = devinfo.choose_primary(["feature/PROJ-1", MID], [pr], {"feature/PROJ-1": 9, MID: 1})
        self.assertEqual(got["id"], 1)


class FetchOneTests(unittest.TestCase):
    def fetch(self, dev_status, bb, enrich_open=True):
        with mock.patch.object(devinfo, "jira_get", return_value=dev_status), mock.patch.object(devinfo, "bb_get", bb):
            return devinfo.fetch_one("123", enrich_open)

    def test_the_reported_ticket_follows_its_newest_branch(self):
        # Jira: three branches, one open PR from the oldest. Bitbucket: the newest branch has the newest commit.
        bb = _bb_router({PLAIN: 1_000_000, MID: 2_000_000, NEWEST: 3_000_000})
        info = self.fetch(_dev_status([_dev_pr(61, PLAIN)]), bb)
        self.assertEqual(info["branch"], NEWEST)
        self.assertEqual(info["branches"][0], NEWEST)
        self.assertEqual(info["pr"], {"state": "none"})
        self.assertEqual([p["id"] for p in info["prs"]], [61])  # still listed, no longer the banner

    def test_a_pr_jira_has_not_indexed_yet_is_found_on_bitbucket(self):
        new_pr = {
            "id": 62, "title": "PROJ-1: continue", "state": "OPEN", "updatedDate": 1_790_000_000_000,
            "fromRef": {"displayId": NEWEST, "repository": {"name": "svc", "slug": "svc", "project": {"key": "PROJ"}}},
            "toRef": {"displayId": "release/x"},
            "reviewers": [{"user": {"displayName": "A"}, "approved": True}],
            "author": {"user": {"displayName": "Me"}},
            "links": {"self": [{"href": f"{REPO}/pull-requests/62"}]},
        }
        bb = _bb_router({PLAIN: 1_000_000, MID: 2_000_000, NEWEST: 3_000_000}, outgoing={NEWEST: [new_pr]})
        info = self.fetch(_dev_status([_dev_pr(61, PLAIN)]), bb)
        self.assertEqual(info["branch"], NEWEST)
        self.assertEqual(info["pr"]["id"], 62)
        self.assertEqual(info["pr"]["sourceBranch"], NEWEST)
        self.assertEqual([p["id"] for p in info["prs"]], [62, 61])
        self.assertTrue(any("direction=OUTGOING" in c for c in bb.calls))

    def test_a_pr_already_in_jira_is_not_fetched_twice(self):
        bb = _bb_router({PLAIN: 1, MID: 2, NEWEST: 3})
        info = self.fetch(_dev_status([_dev_pr(62, NEWEST)]), bb)
        self.assertEqual(info["pr"]["id"], 62)
        self.assertFalse(any("direction=OUTGOING" in c for c in bb.calls))

    def test_bitbucket_down_degrades_to_the_old_rule(self):
        def down(path, timeout=45):
            raise RuntimeError("connection refused")

        info = self.fetch(_dev_status([_dev_pr(61, PLAIN)]), down)
        self.assertEqual((info["branch"], info["pr"]["id"]), (PLAIN, 61))

    def test_a_deleted_branch_cannot_win(self):
        bb = _bb_router({PLAIN: 5_000_000, MID: 2_000_000, NEWEST: None})
        info = self.fetch(_dev_status([_dev_pr(61, PLAIN)]), bb)
        self.assertEqual(info["branch"], PLAIN)

    def test_a_ticket_with_one_branch_makes_no_bitbucket_branch_calls(self):
        single = {"detail": [{"branches": [_branch(PLAIN)], "pullRequests": [_dev_pr(61, PLAIN)]}]}
        bb = _bb_router({})
        info = self.fetch(single, bb)
        self.assertEqual((info["branch"], info["pr"]["id"]), (PLAIN, 61))
        self.assertFalse([c for c in bb.calls if "/commits?" in c])

    def test_single_ticket_refresh_still_ranks_branches(self):
        bb = _bb_router({PLAIN: 1, MID: 2, NEWEST: 3})
        info = self.fetch(_dev_status([_dev_pr(61, PLAIN)]), bb, enrich_open=False)
        self.assertEqual(info["branch"], NEWEST)

    def test_a_failed_dev_status_call_is_none_not_empty(self):
        with mock.patch.object(devinfo, "jira_get", side_effect=RuntimeError("boom")):
            self.assertIsNone(devinfo.fetch_one("1"))


class SettleTests(unittest.TestCase):
    def test_settle_keeps_last_runs_branch_when_this_run_has_no_times(self):
        info = {"branches": [PLAIN, MID], "prs": [{"state": "approved", "id": 61, "sourceBranch": PLAIN}], "times": {}}
        out = devinfo.settle(info, prior_branch=MID)
        self.assertEqual((out["branch"], out["pr"]), (MID, {"state": "none"}))
        self.assertEqual(out["branches"], [MID, PLAIN])

    def test_settle_does_not_mutate_its_input(self):
        info = {"branches": [PLAIN, MID], "prs": [], "times": {MID: 9}}
        devinfo.settle(info)
        self.assertEqual(info["branches"], [PLAIN, MID])


if __name__ == "__main__":
    unittest.main()
