#!/usr/bin/env python3
"""_jira.py: HTTP retry policy, pagination, legacy-JQL fallback and the field formatters.
No network — urllib.request.urlopen / jira_get are monkeypatched."""
import io
import json
import os
import ssl
import sys
import unittest
import urllib.error
import urllib.parse
from email.message import Message
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "jira-intern"))
import _jira  # noqa: E402


class _Resp:
    def __init__(self, payload):
        self._body = json.dumps(payload).encode("utf-8")

    def read(self):
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def http_error(code, headers=None):
    hdrs = Message()
    for k, v in (headers or {}).items():
        hdrs[k] = v
    return urllib.error.HTTPError("https://jira.example/rest", code, f"HTTP {code}", hdrs, io.BytesIO(b""))


class RetryPolicy(unittest.TestCase):
    def setUp(self):
        self.sleeps = []
        self._patches = [
            mock.patch.object(_jira.time, "sleep", side_effect=lambda s: self.sleeps.append(s)),
            mock.patch.object(_jira, "ssl_context", return_value=None),
        ]
        for p in self._patches:
            p.start()
            self.addCleanup(p.stop)

    def get(self, side_effect):
        with mock.patch("urllib.request.urlopen", side_effect=side_effect) as urlopen:
            try:
                result = _jira.get_json("https://jira.example/rest", {}, timeout=5)
            except Exception as e:  # noqa: BLE001 — the test inspects it
                result = e
            return result, urlopen.call_count

    def test_401_is_not_retried(self):
        result, calls = self.get([http_error(401), _Resp({"never": True})])
        self.assertIsInstance(result, urllib.error.HTTPError)
        self.assertEqual(result.code, 401)
        self.assertEqual(calls, 1)
        self.assertEqual(self.sleeps, [])

    def test_400_is_not_retried(self):
        result, calls = self.get([http_error(400)])
        self.assertEqual(getattr(result, "code", None), 400)
        self.assertEqual(calls, 1)

    def test_503_is_retried(self):
        result, calls = self.get([http_error(503), _Resp({"ok": 1})])
        self.assertEqual(result, {"ok": 1})
        self.assertEqual(calls, 2)
        self.assertEqual(len(self.sleeps), 1)

    def test_429_honours_retry_after(self):
        result, calls = self.get([http_error(429, {"Retry-After": "7"}), _Resp({"ok": 2})])
        self.assertEqual(result, {"ok": 2})
        self.assertEqual(calls, 2)
        self.assertEqual(self.sleeps, [7])

    def test_429_without_header_backs_off_and_caps_at_60(self):
        result, _ = self.get([http_error(429), http_error(429, {"Retry-After": "900"}), _Resp({"ok": 3})])
        self.assertEqual(result, {"ok": 3})
        self.assertEqual(self.sleeps, [1, 60])

    def test_network_error_is_retried(self):
        result, calls = self.get([urllib.error.URLError("dns"), _Resp({"ok": 4})])
        self.assertEqual(result, {"ok": 4})
        self.assertEqual(calls, 2)


class Pagination(unittest.TestCase):
    def _run(self, pages, jql="project = X"):
        calls = []

        def fake_get(path, timeout=60):
            params = urllib.parse.parse_qs(path.split("?", 1)[1])
            calls.append(params)
            start = int(params["startAt"][0])
            return pages(start)

        with mock.patch.object(_jira, "jira_get", side_effect=fake_get):
            return _jira.search_jira(jql), calls

    def test_terminates_and_dedups_overlapping_pages(self):
        def pages(start):
            if start == 0:
                return {"issues": [{"key": "A-1"}, {"key": "A-2"}], "total": 3}
            return {"issues": [{"key": "A-2"}, {"key": "A-3"}], "total": 3}

        issues, calls = self._run(pages)
        self.assertEqual([i["key"] for i in issues], ["A-1", "A-2", "A-3"])
        self.assertEqual(len(calls), 2)

    def test_server_ignoring_startat_does_not_spin(self):
        def pages(start):
            return {"issues": [{"key": "A-1"}, {"key": "A-2"}], "total": 100000}

        issues, calls = self._run(pages)
        self.assertEqual([i["key"] for i in issues], ["A-1", "A-2"])
        self.assertEqual(len(calls), 2)

    def test_empty_page_stops(self):
        issues, calls = self._run(lambda start: {"issues": [], "total": 50})
        self.assertEqual(issues, [])
        self.assertEqual(len(calls), 1)

    def test_status_category_fallback_rewrites_both_forms(self):
        seen = []

        def fake_get(path, timeout=60):
            jql = urllib.parse.parse_qs(path.split("?", 1)[1])["jql"][0]
            seen.append(jql)
            if "statusCategory" in jql:
                raise http_error(400)
            return {"issues": [{"key": "B-1"}], "total": 1}

        with mock.patch.object(_jira, "jira_get", side_effect=fake_get):
            issues = _jira.search_jira("(a AND statusCategory != Done) OR (b AND statusCategory = Done)")
        self.assertEqual([i["key"] for i in issues], ["B-1"])
        self.assertEqual(len(seen), 2)
        self.assertIn("status not in (Done, Closed, Resolved)", seen[1])
        self.assertIn("status in (Done, Closed, Resolved)", seen[1])
        self.assertNotIn("statusCategory", seen[1])

    def test_other_400_is_raised(self):
        def fake_get(path, timeout=60):
            raise http_error(400)

        with mock.patch.object(_jira, "jira_get", side_effect=fake_get):
            with self.assertRaises(urllib.error.HTTPError):
                _jira.search_jira("bad jql")


class Tls(unittest.TestCase):
    def setUp(self):
        self._saved = _jira._SSL_CTX
        _jira._SSL_CTX = None
        self.addCleanup(setattr, _jira, "_SSL_CTX", self._saved)

    def test_default_verifies(self):
        with mock.patch.dict(os.environ, {"JIRA_INSECURE_TLS": "", "JIRA_CA_BUNDLE": ""}):
            ctx = _jira.ssl_context()
        self.assertEqual(ctx.verify_mode, ssl.CERT_REQUIRED)
        self.assertTrue(ctx.check_hostname)

    def test_insecure_opt_in_warns(self):
        err = io.StringIO()
        with mock.patch.dict(os.environ, {"JIRA_INSECURE_TLS": "1"}), mock.patch.object(sys, "stderr", err):
            ctx = _jira.ssl_context()
        self.assertEqual(ctx.verify_mode, ssl.CERT_NONE)
        self.assertIn("WARN: TLS verification disabled (JIRA_INSECURE_TLS=1)", err.getvalue())

    def test_missing_bundle_is_a_clear_error(self):
        with mock.patch.dict(os.environ, {"JIRA_INSECURE_TLS": "", "JIRA_CA_BUNDLE": "/nonexistent/ca.pem"}):
            with self.assertRaisesRegex(RuntimeError, "JIRA_CA_BUNDLE"):
                _jira.ssl_context()


class Formatters(unittest.TestCase):
    def test_light_html_keeps_http_href_only(self):
        out = _jira.light_html(
            '<p class="x">Hi <a href="https://e.com/a?b=1&c=2" target="_blank">x</a> '
            '<a href="javascript:alert(1)">y</a> <a href=\'/wiki/page\'>z</a></p>'
        )
        self.assertIn('<a href="https://e.com/a?b=1&amp;c=2">x</a>', out)
        self.assertIn("<a>y</a>", out)
        self.assertNotIn("javascript:", out)
        self.assertIn('<a href="/wiki/page">z</a>', out)
        self.assertTrue(out.startswith("<p>"))

    def test_light_html_drops_unknown_tags_and_attributes(self):
        out = _jira.light_html('<div><SCRIPT src="x">alert(1)</SCRIPT><B onclick="x">bold</B><img src=x></div>')
        self.assertEqual(out, "alert(1)<b>bold</b>")

    def test_light_html_plain_text(self):
        self.assertEqual(_jira.light_html("a & b"), "<p>a &amp; b</p>")
        self.assertIsNone(_jira.light_html(""))

    def test_issue_links_tolerate_missing_fields(self):
        related = _jira.issue_links({
            "issuelinks": [
                {"type": {"outward": "blocks"}, "outwardIssue": {"key": "R-1"}},
                {"type": {"inward": "is blocked by"}, "inwardIssue": {"key": "R-2", "fields": {"summary": "S", "status": {"name": "Done"}}}},
                {"type": {}, "outwardIssue": {}},
            ]
        })
        self.assertEqual(len(related), 2)
        self.assertEqual(related[0]["key"], "R-1")
        self.assertIsNone(related[0]["summary"])
        self.assertIsNone(related[0]["status"])
        self.assertEqual(related[0]["relation"], "blocks")
        self.assertEqual(related[1]["status"], "Done")
        self.assertEqual(related[1]["relation"], "is blocked by")

    def test_story_points(self):
        self.assertEqual(_jira.story_points({"customfield_10402": "3.0"}), 3)
        self.assertIsInstance(_jira.story_points({"customfield_10402": "3.0"}), int)
        self.assertEqual(_jira.story_points({"customfield_10402": 2.5}), 2.5)
        self.assertEqual(_jira.story_points({"customfield_57402": 8}), 8)
        self.assertIsNone(_jira.story_points({"customfield_10402": "n/a"}))
        self.assertIsNone(_jira.story_points({}))

    def test_iso(self):
        self.assertIsNone(_jira.iso("garbage"))
        self.assertIsNone(_jira.iso(None))
        self.assertEqual(_jira.iso("2026-01-02T03:04:05.000+0530"), "2026-01-01T21:34:05Z")
        self.assertEqual(_jira.iso("2026-01-02T03:04:05+0000"), "2026-01-02T03:04:05Z")
        self.assertEqual(_jira.iso(1700000000000), "2023-11-14T22:13:20Z")

    def test_status_column_aliases(self):
        for name in ("Won't Fix", "Wont Fix", "Cancelled", "Canceled", "Rejected", "Closed", "Shipped"):
            self.assertEqual(_jira.status_column(name), "done", name)
        self.assertEqual(_jira.status_column("Moved to QA"), "qa")
        self.assertEqual(_jira.status_column("Peer Review"), "rev")
        self.assertEqual(_jira.status_column("Paused"), "hold")

    def test_issue_key_re(self):
        self.assertTrue(_jira.ISSUE_KEY_RE.fullmatch("PROJ-123"))
        self.assertTrue(_jira.ISSUE_KEY_RE.fullmatch("A2B-1"))
        self.assertIsNone(_jira.ISSUE_KEY_RE.fullmatch("proj-1"))
        self.assertIsNone(_jira.ISSUE_KEY_RE.fullmatch("PROJ-1; rm -rf"))


class CaBundle(unittest.TestCase):
    """A company CA bundle ADDS trust (Jira may use a public certificate, Bitbucket the company CA),
    and ~/.ai/ca-bundle.pem is picked up with no configuration."""

    def setUp(self):
        self.addCleanup(setattr, _jira, "_SSL_CTX", None)
        _jira._SSL_CTX = None
        self.env = mock.patch.dict(os.environ, {}, clear=False)
        self.env.start()
        self.addCleanup(self.env.stop)
        os.environ.pop("JIRA_CA_BUNDLE", None)
        os.environ.pop("JIRA_INSECURE_TLS", None)

    def _ctx(self, default_exists, load=None):
        load = load or mock.Mock()
        with mock.patch.object(_jira.os.path, "isfile", return_value=default_exists), \
                mock.patch.object(_jira.ssl.SSLContext, "load_verify_locations", load):
            ctx = _jira.ssl_context()
        return ctx, load

    def test_system_roots_stay_when_a_bundle_is_added(self):
        os.environ["JIRA_CA_BUNDLE"] = "/certs/company.pem"
        factory = mock.Mock(wraps=ssl.create_default_context)
        with mock.patch.object(_jira.ssl, "create_default_context", factory):
            ctx, load = self._ctx(default_exists=False)
        # Built with the system roots (no cafile, which would REPLACE them), then the bundle added.
        factory.assert_called_once_with()
        load.assert_called_once_with(cafile="/certs/company.pem")
        self.assertEqual(ctx.verify_mode, ssl.CERT_REQUIRED)

    def test_the_default_bundle_is_found_without_configuration(self):
        _, load = self._ctx(default_exists=True)
        load.assert_called_once_with(cafile=_jira.DEFAULT_CA_BUNDLE)

    def test_no_bundle_anywhere_means_system_roots_only(self):
        _, load = self._ctx(default_exists=False)
        load.assert_not_called()

    def test_a_broken_explicit_bundle_is_an_error(self):
        os.environ["JIRA_CA_BUNDLE"] = "/certs/broken.pem"
        with self.assertRaises(RuntimeError):
            self._ctx(default_exists=False, load=mock.Mock(side_effect=ssl.SSLError("bad pem")))

    def test_a_broken_default_bundle_only_warns(self):
        ctx, _ = self._ctx(default_exists=True, load=mock.Mock(side_effect=OSError("unreadable")))
        self.assertEqual(ctx.verify_mode, ssl.CERT_REQUIRED)

    def test_insecure_switch_still_wins(self):
        os.environ["JIRA_INSECURE_TLS"] = "1"
        ctx, load = self._ctx(default_exists=True)
        load.assert_not_called()
        self.assertEqual(ctx.verify_mode, ssl.CERT_NONE)


if __name__ == "__main__":
    unittest.main()
