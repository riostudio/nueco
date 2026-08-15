"""Single owner of external-service endpoint + region configuration (data residency).

Every outbound service this backend talks to - LLM, speech transcription, push
delivery, transactional email, object storage, product analytics, design import, and
the database itself - takes its base URL and region declaration from this module.
The operator DECLARES each service's endpoint and region via environment variables;
this module never hardcodes a vendor URL and never asserts what region a vendor
actually supports - it only enforces that the declaration is present, well-formed,
and Australian.

Privacy Act 1988 (Cth) / APP 11 posture: fail CLOSED. server.py calls validate_all()
at startup; anything missing, malformed, or declared outside the Australian-region
allowlist aborts the boot with a [region-check] error naming every offending
variable. The typed accessors below re-validate on every call, so no code path can
reach an external service through an unchecked endpoint.

Plain stdlib only: service-layer modules import this file, so it must stay
framework-agnostic (no fastapi/starlette) per the repo's architecture rules.
"""
from __future__ import annotations

import os
from dataclasses import dataclass
from urllib.parse import urlparse

# Australian-region allowlist. ap-southeast-2 (Sydney) and ap-southeast-4 (Melbourne)
# are the AWS-style names; "au"/"australia" cover vendors that declare region at
# country granularity. Values are normalised (strip + lowercase) before comparison.
# Keep this list small and explicit - adding a name is a compliance decision.
AU_REGION_ALLOWLIST = frozenset({"ap-southeast-2", "ap-southeast-4", "au", "australia"})

# Grep-able prefix on every error this module raises, so boot failures are easy to
# find in deploy logs.
ERROR_PREFIX = "[region-check]"

_HTTPS_SCHEMES = ("https",)
_MONGO_SCHEMES = ("mongodb", "mongodb+srv")


class RegionConfigError(RuntimeError):
    """Missing/invalid endpoint or region declaration. A RuntimeError per the
    fail-closed boot contract; plain Python so service-layer modules can surface it
    without importing a web framework."""


@dataclass(frozen=True)
class _ServiceSpec:
    """One external service: the env vars declaring its endpoint(s) and its region."""
    name: str
    url_vars: tuple[str, ...]
    region_var: str
    url_schemes: tuple[str, ...] = _HTTPS_SCHEMES


# The declarative registry. Every entry is REQUIRED at boot: a service that is
# "unused" in a given deployment still needs its declaration, because the residency
# gate exists to prove where data CAN go, not to probe which features are on.
_REGISTRY: tuple[_ServiceSpec, ...] = (
    _ServiceSpec("openai", ("OPENAI_BASE_URL",), "OPENAI_REGION"),
    _ServiceSpec("speechmatics", ("SPEECHMATICS_BASE_URL",), "SPEECHMATICS_REGION"),
    _ServiceSpec(
        "expo-push",
        ("EXPO_PUSH_SEND_URL", "EXPO_PUSH_RECEIPTS_URL"),
        "EXPO_PUSH_REGION",
    ),
    _ServiceSpec("resend", ("RESEND_BASE_URL",), "RESEND_REGION"),
    # The S3 bucket name itself stays a plain env read in attachments/ (S3_BUCKET) -
    # it is not an endpoint. AWS_REGION doubles as the boto3 client region.
    _ServiceSpec("aws-s3", (), "AWS_REGION"),
    _ServiceSpec("posthog", ("POSTHOG_HOST",), "POSTHOG_REGION"),
    _ServiceSpec(
        "canva",
        ("CANVA_AUTHORIZE_URL", "CANVA_TOKEN_URL", "CANVA_API_BASE_URL"),
        "CANVA_REGION",
    ),
    _ServiceSpec("mongodb", ("MONGO_URL",), "MONGODB_REGION", url_schemes=_MONGO_SCHEMES),
)


def declared_url_vars() -> tuple[str, ...]:
    """Every endpoint-declaration env var, in registry order."""
    return tuple(var for spec in _REGISTRY for var in spec.url_vars)


def declared_region_vars() -> tuple[str, ...]:
    """Every region-declaration env var, in registry order."""
    return tuple(spec.region_var for spec in _REGISTRY)


def all_declared_env_vars() -> tuple[str, ...]:
    """Every env var this module enforces (endpoints + regions)."""
    return declared_url_vars() + declared_region_vars()


def _read(var: str) -> str | None:
    """Stripped env value, or None when unset/blank (blank == unset: no silent fallback)."""
    raw = os.getenv(var)
    if raw is None:
        return None
    value = raw.strip()
    return value or None


def _check_url(var: str, schemes: tuple[str, ...]) -> tuple[str | None, str | None]:
    """(value, None) when the declaration is usable, else (None, problem description)."""
    value = _read(var)
    if value is None:
        return None, f"{var} is not set (endpoint declaration required)"
    parsed = urlparse(value)
    if parsed.scheme not in schemes or not parsed.netloc:
        expected = " or ".join(f"{scheme}://" for scheme in schemes)
        return None, f"{var} must be a well-formed {expected} URL (got {value!r})"
    return value, None


def _check_region(var: str) -> tuple[str | None, str | None]:
    """(normalised value, None) when declared and Australian, else (None, problem)."""
    value = _read(var)
    if value is None:
        return None, f"{var} is not set (Australian region declaration required)"
    normalised = value.lower()
    if normalised not in AU_REGION_ALLOWLIST:
        allowed = ", ".join(sorted(AU_REGION_ALLOWLIST))
        return None, (
            f"{var}={value!r} is not in the Australian region allowlist ({allowed})"
        )
    return normalised, None


def _require_url(var: str, schemes: tuple[str, ...]) -> str:
    value, problem = _check_url(var, schemes)
    if problem:
        raise RegionConfigError(f"{ERROR_PREFIX} {problem}")
    return value


def _require_region(var: str) -> str:
    value, problem = _check_region(var)
    if problem:
        raise RegionConfigError(f"{ERROR_PREFIX} {problem}")
    return value


def validate_all() -> None:
    """Validate EVERY registered service's endpoint + region declarations.

    Raises RegionConfigError listing every offending variable (not just the first)
    when anything is missing, malformed, or non-Australian. Called once from
    server.py's first startup handler; never catches - a failure must abort the boot.
    """
    problems: list[str] = []
    for spec in _REGISTRY:
        for var in spec.url_vars:
            _, problem = _check_url(var, spec.url_schemes)
            if problem:
                problems.append(f"{spec.name}: {problem}")
        _, problem = _check_region(spec.region_var)
        if problem:
            problems.append(f"{spec.name}: {problem}")
    if problems:
        listing = "\n  - ".join(problems)
        raise RegionConfigError(
            f"{ERROR_PREFIX} data-residency configuration is incomplete or "
            f"non-Australian; refusing to boot. Offending variables:\n  - {listing}"
        )


def _spec(service_name: str) -> _ServiceSpec:
    for spec in _REGISTRY:
        if spec.name == service_name:
            return spec
    raise KeyError(f"unregistered service {service_name!r}")  # pragma: no cover


def _endpoint(service_name: str, var: str) -> str:
    """A validated endpoint for a registered service. The region declaration is
    re-enforced on every call: an endpoint accessor must never succeed while the
    service's region is undeclared or non-Australian."""
    spec = _spec(service_name)
    _require_region(spec.region_var)
    return _require_url(var, spec.url_schemes)


# ---- Typed accessors (the only things call sites import) ----

def openai_base_url() -> str:
    return _endpoint("openai", "OPENAI_BASE_URL")


def speechmatics_base_url() -> str:
    return _endpoint("speechmatics", "SPEECHMATICS_BASE_URL")


def expo_push_send_url() -> str:
    return _endpoint("expo-push", "EXPO_PUSH_SEND_URL")


def expo_push_receipts_url() -> str:
    return _endpoint("expo-push", "EXPO_PUSH_RECEIPTS_URL")


def resend_base_url() -> str:
    return _endpoint("resend", "RESEND_BASE_URL")


def aws_region() -> str:
    """Normalised, allowlist-checked AWS region for the S3 client."""
    return _require_region(_spec("aws-s3").region_var)


def posthog_host() -> str:
    return _endpoint("posthog", "POSTHOG_HOST")


def canva_authorize_url() -> str:
    return _endpoint("canva", "CANVA_AUTHORIZE_URL")


def canva_token_url() -> str:
    return _endpoint("canva", "CANVA_TOKEN_URL")


def canva_api_base_url() -> str:
    return _endpoint("canva", "CANVA_API_BASE_URL")


def mongodb_region() -> str:
    """Normalised, allowlist-checked region declaration for the MongoDB deployment."""
    return _require_region(_spec("mongodb").region_var)
