---
name: nueco-synthetic-test-simulation
description: >
  Use this skill whenever the user wants to run automated synthetic user
  simulations, load tests, security audits, or performance evaluations
  against the Nueco FastAPI backend on Railway with MongoDB Atlas.
  Trigger when the user asks to: simulate users, run test scenarios,
  test in parallel, stress test the backend, check security vulnerabilities,
  evaluate notetaking performance, test real-time sync, or run an autonomous
  fix loop against Nueco. Also trigger for: personas, synthetic data,
  concurrent users, file attachment testing, or automated repair for Nueco.
---

# Nueco Synthetic Test Simulation

A 7-agent mixture-of-experts orchestration for synthetic user simulation,
real-time sync validation, security auditing, and autonomous bug fixing
against Nueco's FastAPI backend on Railway + MongoDB Atlas M0.

---

## What This Skill Does

- Spins up 20 synthetic users across 8 personas running in parallel
- Evaluates notetaking performance, real-time sync, and UX benchmarks
- Runs a full security audit (auth, data isolation, injection, privacy)
- Autonomously fixes identified bugs, performance issues, and vulnerabilities
- Loops up to 5 iterations without human confirmation until all benchmarks pass

---

## Agent Overview

| Agent | Role |
|---|---|
| Agent 1 | Generates 20 synthetic user personas and fixture data |
| Agent 2 | Runs parallel API stress tests via httpx + asyncio |
| Agent 3 | MongoDB safety — connection limits, test DB isolation |
| Agent 4 | Railway load — warmup, HTTPS verification, circuit breaker |
| Agent 5 | Notetaking + real-time sync performance evals |
| Agent 6 | Security eval — auth, isolation, injection, transport, privacy |
| Agent 7 | Autonomous fix loop — reads reports, patches code, re-tests |

---

## Prerequisites

```bash
# Environment variable (required)
export NUECO_API_URL=https://your-app.railway.app

# Python dependencies
pip install pytest pytest-asyncio httpx asyncio
```

---

## Files Generated After Run

```
tests/
  simulate_users.py          # Main async test runner
  conftest.py                # Pytest config, semaphores, DB setup/teardown
  fixtures/
    synthetic_users.json     # 20 personas with realistic note content
  evals/
    notetaking_benchmarks.py # Agent 5 performance assertions
    security_benchmarks.py   # Agent 6 security assertions
  fix_log.md                 # Agent 7 autonomous fix history per iteration
  report.md                  # Unified post-run performance report
  report_security.md         # Security findings with severity ratings
  ESCALATION_REPORT.md       # Issues requiring human review (if any)
```

---

## How to Invoke

```bash
# Run the full 7-agent simulation
claude "$(cat .claude/commands/simulate-users.md)"

# Execute generated tests
pytest tests/ -v --asyncio-mode=auto

# Review what Agent 7 changed autonomously
git diff main fix/auto-repair
cat tests/fix_log.md

# Check anything needing your attention
cat tests/ESCALATION_REPORT.md
```

> Full prompt lives at: `.claude/commands/simulate-users.md`

---

## Key Constraints

- Never exceed 20 concurrent MongoDB connections (Semaphore guard)
- Never touch production DB — all tests run against `nueco_test`
- Agent 7 commits to `fix/auto-repair` branch only, never `main`
- Malicious persona uses synthetic flagged strings only (e.g. SQLI_TEST_PAYLOAD)
- Max 3 file changes per Agent 7 fix iteration

---

## Known Issues to Watch

- **SecureStore dual-write** — `authStorage.ts` writes tokens to both
  SecureStore and AsyncStorage; Agent 6 verifies the AsyncStorage copy
  cannot be read by other apps on rooted devices
- **Railway cold starts** — watch for response times > 2000ms on first
  requests after idle periods; Agent 4 warmup sequence mitigates this
- **MongoDB M0 connection limits** — free tier caps at 500 total;
  Semaphore(20) keeps test suite well under this ceiling
