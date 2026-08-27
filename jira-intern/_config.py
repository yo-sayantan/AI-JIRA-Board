"""Shared config.json resolver for the Python fetch scripts.

Mirrors local-runner/config.mjs's resolveConfigPath() exactly, so every consumer of
config.json — Node or Python — agrees on which file wins. Real, personal values (your
name, corporate ID, internal company hostnames) do NOT live in the repo: the tracked
jira-intern/config.json is a safe, sanitized template so the project can be public.

Resolution order (first match wins):
  1. $AI_CONFIG_FILE                  — explicit override (any path)
  2. ~/.ai/config.json                — your personal config, OUTSIDE any repo
  3. <intern_dir>/config.json         — the in-repo template/fallback

See setup/README.md for how to create ~/.ai/config.json.
"""
import json
import os


def config_path(intern_dir):
    """Which config.json wins for this run — same precedence as config.mjs."""
    override = os.environ.get("AI_CONFIG_FILE")
    if override:
        return override
    personal = os.path.join(os.path.expanduser("~"), ".ai", "config.json")
    if os.path.isfile(personal):
        return personal
    return os.path.join(intern_dir, "config.json")


def load_config(intern_dir):
    """Load the resolved config.json. Missing/invalid → {} (callers already default safely)."""
    try:
        with open(config_path(intern_dir)) as f:
            return json.load(f)
    except Exception:
        return {}


def _strip(url):
    """Normalise a base URL: strip whitespace and any trailing slash."""
    return str(url or "").strip().rstrip("/")


def endpoints(intern_dir):
    """(jira_base, confluence_base, bitbucket_base) from config — no hardcoded company hosts.

    Env vars win so a container or a one-off run can override without touching config:
    JIRA_URL / CONFLUENCE_URL / BITBUCKET_URL (JIRA_URL is already the name used by the
    MCP servers and the secrets file, so this keeps one vocabulary).
    """
    ep = load_config(intern_dir).get("endpoints") or {}
    return (
        _strip(os.environ.get("JIRA_URL") or ep.get("jiraBase")),
        _strip(os.environ.get("CONFLUENCE_URL") or ep.get("confluenceBase")),
        _strip(os.environ.get("BITBUCKET_URL") or ep.get("bitbucketBase")),
    )


def identity(intern_dir):
    """{name, accountId, email} from config — who "assigned to me" means."""
    user = load_config(intern_dir).get("user") or {}
    return {
        "name": str(user.get("name") or "").strip(),
        "accountId": str(user.get("accountId") or "").strip(),
        "email": str(user.get("email") or "").strip(),
    }
