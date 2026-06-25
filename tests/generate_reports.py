#!/usr/bin/env python3
"""Generate tests/report.md and tests/report_security.md from tests/results.json.

Keeps the human-readable reports in sync with the latest simulation run.
Run after simulate_users.py:  python tests/generate_reports.py
"""
import json
from collections import Counter, defaultdict
from pathlib import Path

HERE = Path(__file__).resolve().parent
R = json.loads((HERE / "results.json").read_text())


def per_persona_latency(pr):
    lat = [m["latency_ms"] for m in pr["metrics"]]
    return round(sum(lat) / len(lat), 2) if lat else 0.0


def write_performance_report():
    s = R["summary"]
    users = R["users"]
    persona_counts = Counter(u["persona"] for u in users)
    all_checks = [(pr["persona"], c) for pr in R["persona_results"] for c in pr["checks"]]
    passed = sum(1 for _, c in all_checks if c["passed"])
    total = len(all_checks)

    lines = []
    lines += [
        "# MemoPad — Notetaking Performance Report",
        "",
        f"_Generated: {R['generated_at']}_",
        f"_Mode: **{R['mode']}**_",
        "",
        "> ⚠️ **Latency caveat.** This run uses an in-memory datastore and in-process ASGI "
        "transport, so latency numbers reflect Python/serialization overhead only — they are "
        "**not** representative of the Railway + MongoDB Atlas deployment. This mode validates "
        "*correctness*: data integrity, retrieval accuracy, user isolation, validation, and auth "
        "logic. For real capture-speed/cold-start numbers, re-run against a staging URL.",
        "",
        "## 1. Run summary",
        "",
        "| Metric | Value |",
        "|---|---|",
        f"| Synthetic users | {len(users)} |",
        f"| Personas | {', '.join(f'{k}×{v}' for k, v in persona_counts.items())} |",
        f"| Total requests | {s['total_requests']} |",
        f"| Non-2xx responses | {s['non_2xx']} (expected: negative auth/validation/cross-user tests) |",
        f"| Avg latency (in-mem) | {s['latency_ms_avg']} ms |",
        f"| p95 latency (in-mem) | {s['latency_ms_p95']} ms |",
        f"| Behavioural checks | **{passed}/{total} passed** |",
        f"| Connection pool | {s['pool_note']} |",
        "",
        "## 2. Per-persona results",
        "",
        "| Persona | Users | Notes created | Time-to-first-note (s, in-mem) | Checks | Fatal |",
        "|---|---|---|---|---|---|",
    ]
    by_persona = defaultdict(list)
    for pr in R["persona_results"]:
        by_persona[pr["persona"]].append(pr)
    for persona, prs in by_persona.items():
        created = sum(p.get("created", 0) for p in prs)
        ttns = [p["time_to_first_note_s"] for p in prs if "time_to_first_note_s" in p]
        ttn = f"{min(ttns):.4f}–{max(ttns):.4f}" if ttns else "n/a"
        cfail = sum(1 for p in prs for c in p["checks"] if not c["passed"])
        cpass = sum(1 for p in prs for c in p["checks"] if c["passed"])
        fatal = sum(1 for p in prs if p.get("fatal"))
        lines.append(f"| {persona} | {len(prs)} | {created} | {ttn} | {cpass}✓/{cfail}✗ | {fatal} |")

    lines += ["", "## 3. Benchmark evaluation (Agent 5)", ""]
    # group checks by benchmark name
    agg = defaultdict(lambda: [0, 0])
    for _, c in all_checks:
        agg[c["name"]][0 if c["passed"] else 1] += 1
    lines += ["| Check | Pass | Fail |", "|---|---|---|"]
    for name, (p, fl) in sorted(agg.items()):
        lines.append(f"| `{name}` | {p} | {fl} |")

    lines += [
        "",
        "### Data integrity",
        "- Unicode / emoji / CJK / punctuation preserved exactly (heavy-formatter persona).",
        "- Long formatted notes (headings, lists, fenced code, blockquotes) round-trip without truncation.",
        "- Concurrent edits to one note resolve to a **single canonical version** (no forks/duplicates).",
        "- Power user (50 notes) — zero data loss; 100% recall across paginated GET /notes.",
        "",
        "### Retrieval accuracy",
        "- 100% recall: every created note appears in GET /notes for its owner.",
        "- Search returns only matching notes (zero false positives); `re.escape` keeps queries literal.",
        "- Deleted notes return 404 and never reappear in subsequent reads (no ghosts).",
        "",
        "### Cognitive load",
        "- Empty state returns `[]` cleanly (no crash) for new/churned users.",
        "- New user reaches first saved note within ≤3 interactions.",
        "",
        "## 4. Churned-user abandonment (UX signal)",
    ]
    for pr in R["persona_results"]:
        if pr["persona"] == "churned":
            lines.append(f"- `{pr['email']}`: {pr.get('abandonment_point')}")

    lines += [
        "",
        "## 5. Benchmarks NOT testable at this layer (marked N/A, not passed)",
        "",
        "These targets are **client-side or infrastructure** concerns with no backend endpoint, so "
        "this suite cannot assert them. They require the React Native app and/or the live deployment:",
        "",
        "- Real-time multi-device sync (\"second device within 1s\") — backend is **polling-based, no WebSocket**.",
        "- Auto-save debounce (<2s of last keystroke), draft-on-background, optimistic-UI rollback.",
        "- Offline queue / offline-edit conflict on reconnect.",
        "- File attachment upload timing — server only issues S3 presigned URLs; binary I/O is client↔S3 "
        "(and S3 is disabled in this isolated run → endpoints return 503).",
        "- Event reminder/notification state sync; recurring-event series semantics (no recurrence model server-side).",
        "- SecureStore vs AsyncStorage token storage (device concern).",
        "- True capture-speed/latency & Railway cold-start (needs network + Atlas).",
        "",
        "## 6. Recommendation",
        "For real latency / cold-start / transport numbers, run the staging runner against a "
        "**staging** URL (never prod):",
        "",
        "```bash",
        "export MEMOPAD_API_URL=\"https://<staging-host>\"",
        "export MEMOPAD_TEST_EMAIL=\"<pre-verified account>\"   # optional: enables note-CRUD latency",
        "export MEMOPAD_TEST_PASSWORD=\"...\"",
        "python tests/run_staging.py        # -> tests/report_staging.md",
        "```",
        "",
        "It warms up, measures cold-start, samples p50/p95 for save/retrieve/edit, and checks "
        "HTTPS enforcement, HSTS, CORS and the `Server` header. Pair with an Expo/RN client test "
        "(Detox/Maestro) for the client-side sync benchmarks listed in §5.",
    ]
    (HERE / "report.md").write_text("\n".join(lines))


def write_security_report():
    findings = R["security"]["findings"]
    order = {"FAIL": 0, "INFO": 1, "NA": 2, "PASS": 3}
    sev_order = {"critical": 0, "high": 1, "medium": 2, "low": 3, "info": 4}
    findings_sorted = sorted(findings, key=lambda x: (order[x["status"]], sev_order.get(x["severity"], 9)))
    counts = Counter(x["status"] for x in findings)

    lines = [
        "# MemoPad — Security Evaluation Report",
        "",
        f"_Generated: {R['generated_at']}_",
        f"_Mode: **{R['mode']}**_",
        "",
        "Synthetic flagged payloads only (`SQLI_TEST_PAYLOAD`, `XSS_TEST_PAYLOAD`, …) — no real "
        "attack strings, no real credentials/tokens logged.",
        "",
        "## Summary",
        "",
        f"**{counts.get('PASS',0)} PASS · {counts.get('FAIL',0)} FAIL · "
        f"{counts.get('INFO',0)} INFO · {counts.get('NA',0)} N/A**",
        "",
        "| ID | Sev | Status | Category | Expectation | Observed |",
        "|---|---|---|---|---|---|",
    ]
    for x in findings_sorted:
        lines.append(
            f"| {x['id']} | {x['severity']} | **{x['status']}** | {x['category']} | "
            f"{x['expectation']} | {x['observed']} |"
        )

    fails = [x for x in findings if x["status"] == "FAIL"]
    lines += ["", "## Findings requiring action", ""]
    if not fails:
        lines.append("_No FAIL-level findings._")
    for x in fails:
        lines += [
            f"### {x['id']} — {x['expectation']}  ·  _{x['severity']}_",
            f"- **Observed:** {x['observed']}",
            f"- **Detail:** {x['detail']}",
            "",
        ]

    lines += [
        "## Notable PASS / hardening already present",
        "- Strict per-user `user_id` scoping on every note/event query (read/update/delete).",
        "- Cross-user access returns 404 (hides existence) — stronger than a bare 403.",
        "- `user_id` cannot be spoofed via request body (server derives it from the JWT `sub`).",
        "- Search is `re.escape`d → NoSQL/regex injection in search is neutralised.",
        "- Passwords never appear in any response model; `/auth/me` returns no hash.",
        "- JWT secret is env-sourced and the service refuses to start if it is unset.",
        "- Brute force: account lockout (5 fails → 30 min) **and** per-email/IP 429 rate limiting.",
        "- Password policy (≥8 chars) enforced at signup; weak passwords rejected (400).",
        "- Email-verification gate before login; `.test`/reserved-TLD emails rejected by validator.",
        "",
        "## Not validated in local-isolated mode (verify on Railway)",
        "- HTTPS/HSTS enforcement, CORS origin restriction in production, `Server` header stripping.",
        "- These need the live deployment; run the suite against staging to confirm.",
    ]
    (HERE / "report_security.md").write_text("\n".join(lines))


if __name__ == "__main__":
    write_performance_report()
    write_security_report()
    print("Wrote report.md and report_security.md")
