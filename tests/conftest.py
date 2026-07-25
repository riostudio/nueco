"""
pytest configuration + fixtures for the MemoPad simulation suite.

Boots the real backend in-process against an in-memory Mongo (see harness.py) and
exposes the simulation results to the eval suites. Connection concurrency is capped
per the constraints (Atlas M0 ≤ 20 DB conns; ≤ 50 parallel requests).
"""
import asyncio
import sys
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import harness  # noqa: E402
import simulate_users  # noqa: E402

REQUEST_SEMAPHORE = simulate_users.REQUEST_SEMAPHORE  # 50 parallel requests

RESULTS_PATH = HERE / "results.json"


@pytest.fixture(scope="session")
def results():
    """Run the full simulation once per test session (or reuse fresh results)."""
    data = asyncio.run(simulate_users.run_all())
    return data


@pytest.fixture(scope="session")
def persona_checks(results):
    return [(pr["persona"], c) for pr in results["persona_results"] for c in pr["checks"]]


@pytest.fixture(scope="session")
def security_findings(results):
    return results["security"]["findings"]
