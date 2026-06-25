"""
Agent 5 — Notetaking performance/behaviour benchmark assertions.

Consumes the session-scoped `results` fixture (conftest.py), which runs the full
20-user simulation in-process against the real backend. Each behavioural check
captured during the run becomes an assertion here.

NOTE: latency-based "capture speed" targets are intentionally NOT asserted in
local-isolated mode (in-memory store ⇒ unrepresentative timings). They are
reported in report.md and should be asserted against a staging URL instead.
"""
import pytest


def test_all_20_users_authenticated(results):
    """Every synthetic user (except deliberate churned-at-login) completed auth."""
    fatals = [pr for pr in results["persona_results"] if pr.get("fatal")]
    assert not fatals, f"users failed to run their scenario: {[(p['email'], p['fatal']) for p in fatals]}"
    assert len(results["users"]) == 20


def test_every_persona_check_passed(persona_checks):
    failures = [(p, c["name"], c["detail"]) for p, c in persona_checks if not c["passed"]]
    assert not failures, f"persona behaviour checks failed: {failures}"


@pytest.mark.parametrize("benchmark", [
    "power_zero_data_loss",
    "rapid_no_ghosts",
    "rapid_state_consistent",
    "conflict_single_canonical",
    "long_note_no_truncation",
    "formatting_preserved",
    "unicode_preserved",
    "search_zero_false_positives",
    "search_full_recall",
    "empty_state_ok",
    "first_note_<=3_interactions",
])
def test_named_benchmark(persona_checks, benchmark):
    matching = [c for _, c in persona_checks if c["name"] == benchmark]
    assert matching, f"benchmark {benchmark!r} was never exercised"
    bad = [c for c in matching if not c["passed"]]
    assert not bad, f"{benchmark} failed: {[c['detail'] for c in bad]}"


def test_no_unexpected_server_errors(results):
    """No 5xx anywhere across the whole run."""
    all_reqs = ([r for pr in results["persona_results"] for r in pr["metrics"]]
                + results["security"]["metrics"])
    server_errors = [r for r in all_reqs if r["status"] >= 500]
    assert not server_errors, f"5xx responses observed: {server_errors}"


def test_churn_abandonment_logged(results):
    churned = [pr for pr in results["persona_results"] if pr["persona"] == "churned"]
    assert churned and all(pr.get("abandonment_point") for pr in churned)
