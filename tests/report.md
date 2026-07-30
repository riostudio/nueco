# Nueco — Notetaking Performance Report

_Generated: 2026-06-23T09:16:44.545274+00:00_
_Mode: **local-isolated (in-memory mongomock, in-process ASGI)**_

> ⚠️ **Latency caveat.** This run uses an in-memory datastore and in-process ASGI transport, so latency numbers reflect Python/serialization overhead only — they are **not** representative of the Railway + MongoDB Atlas deployment. This mode validates *correctness*: data integrity, retrieval accuracy, user isolation, validation, and auth logic. For real capture-speed/cold-start numbers, re-run against a staging URL.

## 1. Run summary

| Metric | Value |
|---|---|
| Synthetic users | 20 |
| Personas | power×2, new×3, churned×3, rapid×3, conflict×2, formatter×2, search×3, malicious×2 |
| Total requests | 348 |
| Non-2xx responses | 34 (expected: negative auth/validation/cross-user tests) |
| Avg latency (in-mem) | 33.02 ms |
| p95 latency (in-mem) | 236.72 ms |
| Behavioural checks | **58/58 passed** |
| Connection pool | in-memory mongomock: 1 logical client, <=20 cap honoured by design |

## 2. Per-persona results

| Persona | Users | Notes created | Time-to-first-note (s, in-mem) | Checks | Fatal |
|---|---|---|---|---|---|
| power | 2 | 100 | 1.9293–2.4002 | 4✓/0✗ | 0 |
| new | 3 | 5 | 0.1482–0.1729 | 9✓/0✗ | 0 |
| churned | 3 | 0 | n/a | 3✓/0✗ | 0 |
| rapid | 3 | 0 | n/a | 6✓/0✗ | 0 |
| conflict | 2 | 2 | n/a | 2✓/0✗ | 0 |
| formatter | 2 | 2 | n/a | 6✓/0✗ | 0 |
| search | 3 | 18 | n/a | 6✓/0✗ | 0 |
| malicious | 2 | 0 | n/a | 22✓/0✗ | 0 |

## 3. Benchmark evaluation (Agent 5)

| Check | Pass | Fail |
|---|---|---|
| `auth_reject:expired` | 2 | 0 |
| `auth_reject:malformed` | 2 | 0 |
| `auth_reject:no_token` | 2 | 0 |
| `auth_reject:wrong_secret` | 2 | 0 |
| `auth_reject:wrong_type` | 2 | 0 |
| `churn_no_crash_empty` | 3 | 0 |
| `conflict_single_canonical` | 2 | 0 |
| `created_visible` | 3 | 0 |
| `empty_state_ok` | 3 | 0 |
| `first_note_<=3_interactions` | 3 | 0 |
| `formatting_preserved` | 2 | 0 |
| `literal_stored:NOSQL_TEST_PAYLOAD` | 2 | 0 |
| `literal_stored:PATHTRAVERSAL_TEST_PAYLOAD` | 2 | 0 |
| `literal_stored:SQLI_TEST_PAYLOAD` | 2 | 0 |
| `literal_stored:XSS_TEST_PAYLOAD` | 2 | 0 |
| `long_note_no_truncation` | 2 | 0 |
| `nosql_search_literal` | 2 | 0 |
| `power_search_ok` | 2 | 0 |
| `power_zero_data_loss` | 2 | 0 |
| `rapid_no_ghosts` | 3 | 0 |
| `rapid_state_consistent` | 3 | 0 |
| `search_full_recall` | 3 | 0 |
| `search_zero_false_positives` | 3 | 0 |
| `unicode_preserved` | 2 | 0 |
| `user_id_spoof_ignored` | 2 | 0 |

### Data integrity
- Unicode / emoji / CJK / punctuation preserved exactly (heavy-formatter persona).
- Long formatted notes (headings, lists, fenced code, blockquotes) round-trip without truncation.
- Concurrent edits to one note resolve to a **single canonical version** (no forks/duplicates).
- Power user (50 notes) — zero data loss; 100% recall across paginated GET /notes.

### Retrieval accuracy
- 100% recall: every created note appears in GET /notes for its owner.
- Search returns only matching notes (zero false positives); `re.escape` keeps queries literal.
- Deleted notes return 404 and never reappear in subsequent reads (no ghosts).

### Cognitive load
- Empty state returns `[]` cleanly (no crash) for new/churned users.
- New user reaches first saved note within ≤3 interactions.

## 4. Churned-user abandonment (UX signal)
- `testuser_6@nueco-sim.com`: viewed empty note list, closed app before first note
- `testuser_7@nueco-sim.com`: viewed empty note list, closed app before first note
- `testuser_8@nueco-sim.com`: viewed empty note list, closed app before first note

## 5. Benchmarks NOT testable at this layer (marked N/A, not passed)

These targets are **client-side or infrastructure** concerns with no backend endpoint, so this suite cannot assert them. They require the React Native app and/or the live deployment:

- Real-time multi-device sync ("second device within 1s") — backend is **polling-based, no WebSocket**.
- Auto-save debounce (<2s of last keystroke), draft-on-background, optimistic-UI rollback.
- Offline queue / offline-edit conflict on reconnect.
- File attachment upload timing — server only issues S3 presigned URLs; binary I/O is client↔S3 (and S3 is disabled in this isolated run → endpoints return 503).
- Event reminder/notification state sync; recurring-event series semantics (no recurrence model server-side).
- SecureStore vs AsyncStorage token storage (device concern).
- True capture-speed/latency & Railway cold-start (needs network + Atlas).

## 6. Recommendation
For real latency / cold-start / transport numbers, run the staging runner against a **staging** URL (never prod):

```bash
export NUECO_API_URL="https://<staging-host>"
export NUECO_TEST_EMAIL="<pre-verified account>"   # optional: enables note-CRUD latency
export NUECO_TEST_PASSWORD="..."
python tests/run_staging.py        # -> tests/report_staging.md
```

It warms up, measures cold-start, samples p50/p95 for save/retrieve/edit, and checks HTTPS enforcement, HSTS, CORS and the `Server` header. Pair with an Expo/RN client test (Detox/Maestro) for the client-side sync benchmarks listed in §5.