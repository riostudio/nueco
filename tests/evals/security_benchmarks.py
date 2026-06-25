"""
Agent 6 — Security benchmark assertions.

Consumes the session-scoped `security_findings` fixture. Critical/high controls
must PASS. The two known medium gaps (logout JWT revocation, oversized-payload cap)
are tracked explicitly so the suite stays green while keeping them visible — if a
NEW failure appears, `test_no_unexpected_failures` breaks.
"""
import pytest

# Previously-known medium gaps, now FIXED on fix/auto-repair (AUTH-08, INP-03).
# Any FAIL is now a regression.
KNOWN_MEDIUM_GAPS: set[str] = set()


def _by_status(findings, status):
    return [x for x in findings if x["status"] == status]


def test_no_critical_or_high_failures(security_findings):
    bad = [x for x in security_findings
           if x["status"] == "FAIL" and x["severity"] in ("critical", "high")]
    assert not bad, f"critical/high security failures: {[(x['id'], x['expectation']) for x in bad]}"


def test_no_unexpected_failures(security_findings):
    """Only the documented medium gaps may FAIL; anything else is a regression."""
    failing_ids = {x["id"] for x in _by_status(security_findings, "FAIL")}
    unexpected = failing_ids - KNOWN_MEDIUM_GAPS
    assert not unexpected, f"unexpected NEW security failures: {unexpected}"


@pytest.mark.parametrize("finding_id", [
    "AUTHZ-01", "AUTHZ-02", "AUTHZ-03", "AUTHZ-04",   # cross-user isolation
    "AUTH-01", "AUTH-02", "AUTH-03", "AUTH-04", "AUTH-05",  # token rejection matrix
    "AUTH-06",                                          # brute force
    "AUTH-07",                                          # refresh revoked on logout
    "AUTH-08",                                          # access token revoked on logout (FIXED)
    "AUTH-09",                                          # password policy
    "PRIV-01",                                          # password never returned
    "INP-01", "INP-02", "INP-03", "INP-04",            # input validation (INP-03 FIXED)
    "SEC-01",                                           # secrets hygiene
])
def test_security_control_passes(security_findings, finding_id):
    match = next((x for x in security_findings if x["id"] == finding_id), None)
    assert match is not None, f"security control {finding_id} not exercised"
    assert match["status"] == "PASS", f"{finding_id} ({match['expectation']}): observed {match['observed']}"


def test_logout_revokes_access_token(security_findings):
    """FIXED on fix/auto-repair: access token bound to session via `sid`."""
    x = next(x for x in security_findings if x["id"] == "AUTH-08")
    assert x["status"] == "PASS", x["observed"]


def test_oversized_payload_rejected(security_findings):
    """FIXED on fix/auto-repair: server-side 256KB content cap -> 413."""
    x = next(x for x in security_findings if x["id"] == "INP-03")
    assert x["status"] == "PASS", x["observed"]


def test_injection_payloads_stored_as_literals(security_findings, persona_checks):
    """Synthetic flagged payloads round-trip as literal text, never executed."""
    lit = [c for _, c in persona_checks if c["name"].startswith("literal_stored:")]
    assert lit, "no injection-literal checks ran"
    bad = [c for c in lit if not c["passed"]]
    assert not bad, f"payloads not stored literally: {[c['name'] for c in bad]}"
