# Nueco: Transcription Migration & Recording Trust Controls

**Owner:** Rio
**Last updated:** 11 August 2026
**Status:** Phase 0 not started

---

## Start here

**Build sequence lives in [../plan.md](../plan.md).** This folder holds the detailed specs each milestone references.

Speechmatics is decided. The evaluation gate has been removed; validation happens during shadow mode in M3 instead.

Start with M1 (provider abstraction) and M4 (client-side VAD) in parallel. Neither blocks on anything, both are half-day tasks.

`transcription_eval.py` is now a regression tool for comparing providers during shadow mode, not a gate. `03-phase-0-validation.md` is kept for the clip recipe and scoring method.

---

## Files

| File | What it covers | Blocked by |
|---|---|---|
| [01-context.md](01-context.md) | Why Speechmatics, how they handle voice data, known unknowns | — |
| [02-decisions.md](02-decisions.md) | Decided vs still open | — |
| [03-phase-0-validation.md](03-phase-0-validation.md) | The eval, decision rule | — |
| [04-vad.md](04-vad.md) | Client-side VAD | — |
| [05-retention.md](05-retention.md) | Server zero-retention, device rolling window, error reporting | — |
| [06-note-editor-player.md](06-note-editor-player.md) | Audio player + transcript UI, export | 05 |
| [07-privacy-policy.md](07-privacy-policy.md) | Policy copy, DPA, controller obligations | 08 |
| [08-speechmatics-migration.md](08-speechmatics-migration.md) | Abstraction layer, implementation, cutover | 03 |
| [09-recording-controls.md](09-recording-controls.md) | Capture model, disclosure, Play Store compliance | — |
| [10-conversation-mode.md](10-conversation-mode.md) | Multi-voice: what's achievable, what isn't | go decision + legal |
| [11-consent-prompt.md](11-consent-prompt.md) | Consent prompt spec | 10 |
| [12-appendices.md](12-appendices.md) | Rejected alternatives, evidence quality | — |

Script: `transcription_eval.py` (repo root)

---

## Sequencing

```
03  Validation gate                  2-3 hours    ← START HERE
 │
 ├── Speechmatics wins ──→ 08  Migration ──→ 07  Privacy policy
 │                              │
 └── OpenAI wins ───────────────┤
                                ↓
                        04  VAD  (do regardless)
                                ↓
                        05  Retention ──→ 06  Note editor player
                                ↓
                        09  Recording controls
                                ↓
                        10 + 11  Conversation mode (separate go decision)
```

04, 05, 06 and 09 can run in parallel with 08 once the abstraction layer is in place.

---

## Independent of everything else

These ship whatever Phase 0 says, and none of them are blocked:

- **04** Client-side VAD
- **05** Retention architecture
- **06** Note editor audio player
- **09** Recording controls and Play compliance

If the migration question stalls, these are still the right work.
