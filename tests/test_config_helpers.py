#!/usr/bin/env python3
"""_config helpers added for the fetch pipeline: Bitbucket hints, proof endpoints, day stamps."""
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
INTERN = ROOT / "jira-intern"
sys.path.insert(0, str(INTERN))
import _config  # noqa: E402


class _Override:
    """AI_CONFIG_FILE pointing at a sparse personal override, restored afterwards."""

    def __init__(self, override):
        self.override = override

    def __enter__(self):
        fd, self.path = tempfile.mkstemp(suffix=".json")
        with os.fdopen(fd, "w") as f:
            json.dump(self.override, f)
        self.patch = mock.patch.dict(os.environ, {"AI_CONFIG_FILE": self.path})
        self.patch.start()
        return self

    def __exit__(self, *exc):
        self.patch.stop()
        os.unlink(self.path)
        return False


class BitbucketHints(unittest.TestCase):
    def test_defaults_are_empty(self):
        with _Override({}):
            self.assertEqual(_config.bitbucket_hints(str(INTERN)), {"projectMap": {}, "repoHints": {}})

    def test_keys_are_upper_cased_and_empty_entries_dropped(self):
        with _Override({"bitbucket": {
            "projectMap": {"proj": "BBPROJ", "empty": ""},
            "repoHints": {"proj": ["api", " api ", "ui", ""], "none": []},
        }}):
            hints = _config.bitbucket_hints(str(INTERN))
        self.assertEqual(hints["projectMap"], {"PROJ": "BBPROJ"})
        self.assertEqual(hints["repoHints"], {"PROJ": ["api", "ui"]})

    def test_schema_rejects_non_string_repo(self):
        with _Override({"bitbucket": {"repoHints": {"PROJ": [1]}}}):
            with self.assertRaisesRegex(RuntimeError, "configuration invalid"):
                _config.load_config(str(INTERN))


class ProofEndpoints(unittest.TestCase):
    def test_config_values(self):
        with _Override({"endpoints": {
            "checkmarxBase": "https://t.cxone.cloud/",
            "checkmarxAuthUrl": "https://iam.cxone.cloud/token",
            "dynatraceTenants": {"prod": "abc12345", "uat": "", "dev": "xyz"},
        }}), mock.patch.dict(os.environ, {}, clear=False):
            for var in ("CHECKMARX_BASE_URL", "CHECKMARX_URL", "CHECKMARX_AUTH_URL", "DYNATRACE_TENANTS"):
                os.environ.pop(var, None)
            ep = _config.proof_endpoints(str(INTERN))
            base, tenants = _config.checkmarx_base(str(INTERN)), _config.dynatrace_tenants(str(INTERN))
        self.assertEqual(ep["checkmarxBase"], "https://t.cxone.cloud")
        self.assertEqual(ep["checkmarxAuthUrl"], "https://iam.cxone.cloud/token")
        self.assertEqual(ep["dynatraceTenants"], {"prod": "abc12345", "dev": "xyz"})
        self.assertEqual(base, "https://t.cxone.cloud")
        self.assertEqual(tenants, {"prod": "abc12345", "dev": "xyz"})

    def test_env_overrides_canonical_first(self):
        with _Override({}), mock.patch.dict(os.environ, {
            "CHECKMARX_BASE_URL": "https://canon.example/",
            "CHECKMARX_URL": "https://legacy.example",
            "DYNATRACE_TENANTS": "prod=p1, uat=u1,dev=",
        }):
            ep = _config.proof_endpoints(str(INTERN))
        self.assertEqual(ep["checkmarxBase"], "https://canon.example")
        self.assertEqual(ep["dynatraceTenants"], {"prod": "p1", "uat": "u1"})

    def test_env_json_tenants(self):
        with _Override({}), mock.patch.dict(os.environ, {"DYNATRACE_TENANTS": '{"prod": "p9", "uat": ""}'}):
            self.assertEqual(_config.proof_endpoints(str(INTERN))["dynatraceTenants"], {"prod": "p9"})
        with _Override({}), mock.patch.dict(os.environ, {"DYNATRACE_TENANTS": "{not json"}):
            self.assertEqual(_config.proof_endpoints(str(INTERN))["dynatraceTenants"], {})

    def test_defaults_disabled(self):
        with _Override({}), mock.patch.dict(os.environ, {}, clear=False):
            for var in ("CHECKMARX_BASE_URL", "CHECKMARX_URL", "CHECKMARX_AUTH_URL", "DYNATRACE_TENANTS"):
                os.environ.pop(var, None)
            ep = _config.proof_endpoints(str(INTERN))
        self.assertEqual(ep, {"checkmarxBase": "", "checkmarxAuthUrl": "", "dynatraceTenants": {}})


class DayStamp(unittest.TestCase):
    def test_today_follows_configured_zone(self):
        from datetime import datetime
        from zoneinfo import ZoneInfo

        for zone in ("Pacific/Kiritimati", "Pacific/Pago_Pago", "Asia/Kolkata"):
            with _Override({"app": {"timeZone": zone}}):
                stamp = _config.today_str(str(INTERN))
            self.assertEqual(stamp, datetime.now(ZoneInfo(zone)).strftime("%Y-%m-%d"), zone)


if __name__ == "__main__":
    unittest.main()
