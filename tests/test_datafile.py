#!/usr/bin/env python3
"""datafile.py: byte parity with local-runner/sync-datajs.mjs, atomic writes, the data lock."""
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
INTERN = ROOT / "jira-intern"
sys.path.insert(0, str(INTERN))
import datafile  # noqa: E402

FIXTURE = {
    "generatedAt": "2026-10-08T00:00:00Z",
    "user": {"name": "Zoë", "accountId": "X1"},
    "notes": ["é ☕ </script> \"quoted\" \\ back", "tab\tnew\nline   sep"],
    "tickets": [{"key": "PROJ-1", "title": "Ünïcode — dash", "storyPoints": 3, "pr": {"state": "none"}, "subtasks": []}],
    "completed": [],
}


class NodeParity(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="datafile-test-")
        self.addCleanup(shutil.rmtree, self.tmp, True)

    def test_python_and_node_write_identical_data_js(self):
        if shutil.which("node") is None:
            self.skipTest("node is not on PATH")
        datafile.write_outputs(FIXTURE, intern_dir=self.tmp)
        py_js = Path(self.tmp, "data.js").read_bytes()
        py_json = Path(self.tmp, "data.json").read_bytes()
        self.assertIn("é ☕ </script>".encode("utf-8"), py_json)
        self.assertNotIn(b"\\u00e9", py_json)

        os.remove(Path(self.tmp, "data.js"))
        result = subprocess.run(
            ["node", str(INTERN / "local-runner" / "sync-datajs.mjs"), self.tmp],
            cwd=ROOT, text=True, capture_output=True,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        node_js = Path(self.tmp, "data.js").read_bytes()
        self.assertEqual(py_js, node_js)

    def test_data_json_round_trips(self):
        datafile.write_outputs(FIXTURE, intern_dir=self.tmp)
        self.assertEqual(datafile.read_json(Path(self.tmp, "data.json")), FIXTURE)


class AtomicWrite(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="datafile-test-")
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.target = os.path.join(self.tmp, "out.json")
        with open(self.target, "w", encoding="utf-8") as f:
            f.write("original")

    def test_target_untouched_when_fsync_raises(self):
        with mock.patch.object(datafile.os, "fsync", side_effect=OSError("disk full")):
            with self.assertRaises(OSError):
                datafile.atomic_write(self.target, "replacement")
        with open(self.target, encoding="utf-8") as f:
            self.assertEqual(f.read(), "original")
        self.assertEqual([n for n in os.listdir(self.tmp) if n.startswith(".tmp-")], [])

    def test_successful_write_replaces(self):
        datafile.atomic_dump(self.target, {"a": "é"})
        with open(self.target, encoding="utf-8") as f:
            self.assertEqual(f.read(), '{\n  "a": "é"\n}')
        self.assertEqual([n for n in os.listdir(self.tmp) if n.startswith(".tmp-")], [])

    def test_read_json_default_and_missing(self):
        self.assertEqual(datafile.read_json(os.path.join(self.tmp, "nope.json"), {"d": 1}), {"d": 1})
        self.assertIsNone(datafile.read_json(os.path.join(self.tmp, "nope.json")))


class DataLock(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="datafile-test-")
        self.addCleanup(shutil.rmtree, self.tmp, True)

    def test_reentrant_and_creates_lock_file(self):
        with datafile.data_lock(self.tmp):
            with datafile.data_lock(self.tmp):  # nested writer (upsert → write_outputs) must not deadlock
                datafile.write_outputs({"tickets": [], "completed": []}, intern_dir=self.tmp)
        self.assertTrue(os.path.isfile(os.path.join(self.tmp, ".data.lock")))
        self.assertEqual(getattr(datafile._lock_state, "depth", 0), 0)

    def test_without_fcntl_is_a_noop(self):
        with mock.patch.object(datafile, "fcntl", None):
            with datafile.data_lock(self.tmp):
                pass
        self.assertFalse(os.path.exists(os.path.join(self.tmp, ".data.lock")))


if __name__ == "__main__":
    unittest.main()
