"""Unit tests for core/regions.py (data-residency enforcement) plus a source guard.

Self-contained: monkeypatched env only - no network, no database, no third-party
imports beyond pytest. Run from backend/:

    python3 -m pytest tests/test_regions.py

(wired into .github/workflows/backend-checks.yml; pytest.ini's testpaths scopes the
repo-root eval suite, so this file is only collected when named explicitly.)
"""
import sys
from pathlib import Path

import pytest

BACKEND_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND_DIR))

from core import regions  # noqa: E402

# A complete, valid, Australian fixture. Hosts use the .invalid TLD on purpose: the
# tests must never contain a real vendor endpoint (the source guard below enforces
# that for the rest of backend/, and this fixture proves it needs no exceptions).
VALID_AU_ENV = {
    "OPENAI_BASE_URL": "https://openai.example.invalid/v1",
    "OPENAI_REGION": "ap-southeast-2",
    "SPEECHMATICS_BASE_URL": "https://speechmatics.example.invalid/v2",
    "SPEECHMATICS_REGION": "ap-southeast-2",
    "EXPO_PUSH_SEND_URL": "https://push.example.invalid/api/v2/push/send",
    "EXPO_PUSH_RECEIPTS_URL": "https://push.example.invalid/api/v2/push/getReceipts",
    "EXPO_PUSH_REGION": "ap-southeast-2",
    "RESEND_BASE_URL": "https://resend.example.invalid",
    "RESEND_REGION": "ap-southeast-2",
    "AWS_REGION": "ap-southeast-2",
    "POSTHOG_HOST": "https://posthog.example.invalid",
    "POSTHOG_REGION": "ap-southeast-2",
    "CANVA_AUTHORIZE_URL": "https://canva.example.invalid/api/oauth/authorize",
    "CANVA_TOKEN_URL": "https://canva.example.invalid/api/oauth/token",
    "CANVA_API_BASE_URL": "https://canva.example.invalid/rest/v1",
    "CANVA_REGION": "ap-southeast-2",
    "MONGO_URL": "mongodb://mongo.example.invalid:27017",
    "MONGODB_REGION": "ap-southeast-2",
}

ALL_VARS = sorted(VALID_AU_ENV)
REGION_VARS = sorted(var for var in VALID_AU_ENV if var in regions.declared_region_vars())


@pytest.fixture
def clean_env(monkeypatch):
    """Every declared var removed - the environment the operator starts from."""
    for var in regions.all_declared_env_vars():
        monkeypatch.delenv(var, raising=False)
    return monkeypatch


@pytest.fixture
def valid_env(clean_env):
    for var, value in VALID_AU_ENV.items():
        clean_env.setenv(var, value)
    return clean_env


def test_fixture_covers_the_whole_registry():
    """If a service is added to the registry, this fixture must grow with it."""
    assert set(VALID_AU_ENV) == set(regions.all_declared_env_vars())


# (a) Missing any required var -> validate_all raises, and the message names the var.
@pytest.mark.parametrize("missing_var", ALL_VARS)
def test_missing_any_var_fails_closed_and_names_it(valid_env, missing_var):
    valid_env.delenv(missing_var)
    with pytest.raises(regions.RegionConfigError) as excinfo:
        regions.validate_all()
    message = str(excinfo.value)
    assert regions.ERROR_PREFIX in message
    assert missing_var in message


def test_empty_environment_lists_every_offending_var(clean_env):
    """One RuntimeError naming EVERY problem, not just the first."""
    with pytest.raises(regions.RegionConfigError) as excinfo:
        regions.validate_all()
    message = str(excinfo.value)
    assert regions.ERROR_PREFIX in message
    for var in ALL_VARS:
        assert var in message, f"{var} missing from the boot-failure message"


def test_blank_value_counts_as_missing(valid_env):
    valid_env.setenv("OPENAI_REGION", "   ")
    with pytest.raises(regions.RegionConfigError) as excinfo:
        regions.validate_all()
    assert "OPENAI_REGION is not set" in str(excinfo.value)


# (b) A non-AU region declaration -> raises and names the var.
@pytest.mark.parametrize("region_var", REGION_VARS)
def test_non_australian_region_declaration_rejected(valid_env, region_var):
    valid_env.setenv(region_var, "us-east-1")
    with pytest.raises(regions.RegionConfigError) as excinfo:
        regions.validate_all()
    message = str(excinfo.value)
    assert region_var in message
    assert "allowlist" in message


@pytest.mark.parametrize("bad_url", ["not-a-url", "http://openai.example.invalid/v1", "https://"])
def test_malformed_or_insecure_url_rejected(valid_env, bad_url):
    valid_env.setenv("OPENAI_BASE_URL", bad_url)
    with pytest.raises(regions.RegionConfigError) as excinfo:
        regions.validate_all()
    assert "OPENAI_BASE_URL" in str(excinfo.value)


def test_mongo_url_must_use_a_mongodb_scheme(valid_env):
    valid_env.setenv("MONGO_URL", "https://mongo.example.invalid")
    with pytest.raises(regions.RegionConfigError) as excinfo:
        regions.validate_all()
    assert "MONGO_URL" in str(excinfo.value)


# (c) Full valid AU fixture -> passes, and accessors return the declared values.
def test_valid_australian_environment_passes(valid_env):
    regions.validate_all()  # must not raise

    assert regions.openai_base_url() == "https://openai.example.invalid/v1"
    assert regions.speechmatics_base_url() == "https://speechmatics.example.invalid/v2"
    assert regions.expo_push_send_url() == "https://push.example.invalid/api/v2/push/send"
    assert regions.expo_push_receipts_url() == "https://push.example.invalid/api/v2/push/getReceipts"
    assert regions.resend_base_url() == "https://resend.example.invalid"
    assert regions.aws_region() == "ap-southeast-2"
    assert regions.posthog_host() == "https://posthog.example.invalid"
    assert regions.canva_authorize_url() == "https://canva.example.invalid/api/oauth/authorize"
    assert regions.canva_token_url() == "https://canva.example.invalid/api/oauth/token"
    assert regions.canva_api_base_url() == "https://canva.example.invalid/rest/v1"
    assert regions.mongodb_region() == "ap-southeast-2"


def test_region_declaration_is_normalised(valid_env):
    """Case/whitespace around a valid AU region must not fail the boot."""
    valid_env.setenv("OPENAI_REGION", "  AP-Southeast-2 ")
    regions.validate_all()  # must not raise


def test_accessors_re_enforce_the_region_declaration(valid_env):
    """Call-site accessors fail closed too, not just the startup gate."""
    valid_env.delenv("OPENAI_REGION")
    with pytest.raises(regions.RegionConfigError):
        regions.openai_base_url()
    valid_env.delenv("AWS_REGION")
    with pytest.raises(regions.RegionConfigError):
        regions.aws_region()


# (d) Source guard: no forbidden endpoint literal anywhere in backend/ outside
# core/regions.py and the test suite. This is what keeps the next hardcoded URL from
# sneaking back in - the CI grep is this test.
FORBIDDEN_LITERALS = (
    "us.i.posthog.com",
    "api.resend.com",
    "exp.host",
    "api.openai.com",
    "speechmatics.com",
    "canva.com",
    "us-east-1",
    "web-production-a3258.up.railway.app",
)

# Directories that may legitimately contain these strings: this test suite (the
# forbidden list lives here), virtualenvs, bytecode caches, VCS metadata.
_EXCLUDED_DIRS = {"tests", ".venv", "venv", "__pycache__", ".git", ".mypy_cache"}


def _is_dotenv(rel: Path) -> bool:
    # Operator-supplied values, not source: gitignored locally, absent in CI checkouts.
    return rel.name == ".env" or rel.name.startswith(".env.")


def test_no_forbidden_endpoint_literals_in_backend_source():
    offenders = []
    for path in sorted(BACKEND_DIR.rglob("*")):
        if not path.is_file():
            continue
        rel = path.relative_to(BACKEND_DIR)
        if any(part in _EXCLUDED_DIRS for part in rel.parts):
            continue
        if rel.as_posix() == "core/regions.py" or _is_dotenv(rel):
            continue
        try:
            text = path.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            continue
        for literal in FORBIDDEN_LITERALS:
            if literal in text:
                offenders.append(f"{rel}: contains {literal!r}")
    assert not offenders, (
        "hardcoded external-service endpoint(s) found outside core/regions.py - "
        "declare them via env instead:\n  - " + "\n  - ".join(offenders)
    )
