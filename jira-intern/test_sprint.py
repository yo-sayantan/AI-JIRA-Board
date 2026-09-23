#!/usr/bin/env python3
"""sprintOverflow is true only when Jira lists more than one distinct sprint name."""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _sprint import apply_sprint, sprint_fields


class SprintFields(unittest.TestCase):
    def test_empty(self):
        self.assertEqual(sprint_fields(None), {"sprint": None, "sprintOverflow": False, "sprintCount": 0})

    def test_one(self):
        raw = ["com.atlassian.greenhopper.service.sprint.Sprint@[name=PROJ 89_2026,state=ACTIVE,startDate=2026-06-24,endDate=2026-07-08]"]
        f = sprint_fields(raw)
        self.assertFalse(f["sprintOverflow"])
        self.assertEqual(f["sprintCount"], 1)
        self.assertIn("PROJ 89_2026", f["sprint"])

    def test_carry_over(self):
        raw = [
            "name=PROJ 88_2026,state=CLOSED,startDate=2026-06-10,endDate=2026-06-23",
            "name=PROJ 89_2026,state=ACTIVE,startDate=2026-06-24,endDate=2026-07-08",
        ]
        f = sprint_fields(raw)
        self.assertTrue(f["sprintOverflow"])
        self.assertEqual(f["sprintCount"], 2)
        self.assertIn("PROJ 89_2026", f["sprint"])

    def test_apply(self):
        t = {}
        apply_sprint(t, [{"name": "A", "state": "closed"}, {"name": "B", "state": "active"}])
        self.assertTrue(t["sprintOverflow"])
        self.assertEqual(t["sprintCount"], 2)


if __name__ == "__main__":
    unittest.main()
