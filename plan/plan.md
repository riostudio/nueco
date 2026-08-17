# Nueco: Execution Plan

**Owner:** Rio
**Last updated:** 11 August 2026
**Status:** Ready to build

This is the build sequence. Detailed specs live in `plan/`. Each milestone below links to its spec file.

**Decision taken:** Speechmatics is the transcription provider. The evaluation gate has been removed. Validation now happens *during* the migration via shadow mode, not before it.

---

## Scope

Three things ship:

1. **Transcription migration** to Speechmatics, with immediate job deletion
2. **Note editor audio player** — recording playable and exportable in the note, transcript beneath it
3. **Conversation mode** — multi-voice capture with consent prompt and honest overlap handling

Everything else in `plan/` supports these.

---

## Milestone 1: Provider abstraction

**Spec:** [plan/08-speechmatics-migration.md](plan/08-speechmatics-migration.md)
**Effort:** half a day
**Blocks:** everything downstream

Extract the transcription call behind an interface before touching Speechmatics. Audio in, plain text plus metadata out. Implement the existing OpenAI path against it, deploy, confirm no behaviour change.

**Done when:** OpenAI transcription runs through the new interface in production with no user-visible difference, and provider is selectable by environment variable.

Do this first even though it produces no visible change. It makes the swap a config flip and gives a one-line rollback.

---

## Milestone 2: Speechmatics implementation

**Spec:** [plan/08-speechmatics-migration.md](plan/08-speechmatics-migration.md)
**Effort:** half a day
**Depends on:** M1

- Speechmatics Python batch client, API key in Railway env vars
- `language="en"` explicit, diarization **off** for single-voice capture
- Response flattener producing flat text for the schema-structuring step
- **Preserve word-level timestamps.** M4 needs them for tap-to-seek. Discarding here means rebuilding later
- **DELETE the job immediately after retrieving the transcript.** In a `finally` block, failures logged loudly. This is what takes retention from 7 days to seconds
- Reconciliation sweep: list jobs older than a few minutes, delete them, catching inline-delete failures
- Rate limit handling (10 jobs/sec on `POST /v2/jobs`), exponential backoff with jitter, capped retries
- Confirm the account is **not** enrolled in the training-data discount programme

**Done when:** a note transcribes end to end via Speechmatics, the job is confirmed deleted, and word timestamps are persisted alongside the text.

---

## Milestone 3: Shadow mode and cutover

**Spec:** [plan/08-speechmatics-migration.md](plan/08-speechmatics-migration.md)
**Effort:** 1 week elapsed, low active time
**Depends on:** M2

Run both providers on a sample of real traffic. Log both transcripts. Compare offline.

`plan/transcription_eval.py` is now a regression tool rather than a gate. Point it at any clips you accumulate to compare error counts, insertions, and latency between the two.

**Watch specifically for:**
- Wall-clock latency to usable transcript. If Speechmatics is materially slower, that is a UX regression and may warrant the realtime API instead (zero storage, lower latency, $0.0067/min vs $0.0050)
- Hallucinated content on low-signal audio. Unknown behaviour for Speechmatics, so measure rather than assume

**Done when:** a week of shadow data reviewed, default flipped, OpenAI path retained for 30 days.

---

## Milestone 4: Client-side VAD

**Spec:** [plan/04-vad.md](plan/04-vad.md)
**Effort:** half a day
**Depends on:** nothing. Can run in parallel from day one

Silero VAD on device before upload. **Segment, do not strip** — naive silence removal destroys the pause structure the model uses for sentence boundaries and punctuation.

**Done when:** extended silence is cut from uploads, punctuation quality is unchanged, and upload size drops measurably.

---

## Milestone 5: Retention architecture

**Spec:** [plan/05-retention.md](plan/05-retention.md)
**Effort:** 1 day
**Depends on:** nothing

Server side: zero retention, delete in a `finally` block, audit every path where audio touches disk.

Device side: local Opus at ~16kbps mono, 30-day rolling window default, Settings control for immediate / 30 days / indefinite, background cleanup job, storage usage shown.

**Done when:** a transcription completes leaving no server-side artifact on either the success or failure path, and device audio expires on schedule.

---

## Milestone 6: Note editor audio player — **Requirement 1**

**Spec:** [plan/06-note-editor-player.md](plan/06-note-editor-player.md)
**Effort:** 2 to 3 days
**Depends on:** M5 (device storage), M2 (word timestamps, for seek only)

The recording is a first-class element of the note. Player at the top of the note body, transcript directly beneath, visually one unit.

**Player**
- Renders immediately after capture completes, before the user does anything else
- Play/pause, scrubber, elapsed and total duration
- Waveform or amplitude bars rendered from the Opus file — makes silence and speech visually distinguishable when checking a suspect transcript
- Playback speed 1x / 1.5x / 2x
- Keeps playing while the user scrolls or edits

**Transcript beneath**
- Editable text, grouped with the player rather than in a separate card
- Tap a word to seek audio to that point, using the timestamps preserved in M2
- Edited words visually distinguishable from raw transcription

**Export**
- Share audio to device via the Android share sheet
- Filename uses note title and capture date, not a UUID
- Transcript exports separately, so sharing the words does not require sharing the recording
- First-time warning when exporting audio from a conversation-mode note

**Expiry**
- Player replaced by a plain explanation when local audio has passed the retention window
- Warn before expiry on notes the user has edited or starred

**Done when:** a user can capture a note, immediately play it back, scrub to any point, tap a word to jump there, edit the transcript, and export either audio or text separately.

---

## Milestone 7: Recording controls and Play compliance

**Spec:** [plan/09-recording-controls.md](plan/09-recording-controls.md)
**Effort:** 1 to 2 days
**Depends on:** nothing

Session-based foreground capture only, correct `microphone` foreground service type, audible start/stop chime with visual fallback, persistent notification, unambiguous in-app state. No background listening, no wake word, no stealth affordances ever.

Play Store: accurate Data Safety declaration, no Accessibility API for audio capture, privacy policy stating where processing happens.

**Done when:** no code path can hold the microphone outside an active user-initiated session, and the Play declarations match actual behaviour.

**Required before M8.** Conversation mode without these is not shippable.

---

## Milestone 8: Conversation mode — **Requirement 2**

**Spec:** [plan/10-conversation-mode.md](plan/10-conversation-mode.md) and [plan/11-consent-prompt.md](plan/11-consent-prompt.md)
**Effort:** 1 to 2 weeks
**Depends on:** M2, M6, M7, plus legal review

### 8a. Capability boundary — read before building

Multi-voice capture works for **turn-taking conversation**. It does not work for **sustained simultaneous speech**, and no available system changes that.

An ASR system achieving 5.5% WER on single-speaker audio can produce 84.7% WER on two-speaker overlapped speech. Research approaches exist (permutation invariant training, serialized output training, target-speaker ASR) but none are in a commercial API, and they degrade single-talker performance, which is Nueco's primary case. Speechmatics diarization assigns one speaker per frame; during overlap it picks one and does not flag that it guessed.

| Situation | Achievable |
|---|---|
| Turn-taking, minimal overlap, moderate noise | Yes |
| Brief interruptions, back-channel | Mostly, expect occasional misattribution |
| Sustained simultaneous speech | **No** |
| Noisy room plus overlap | **No** |

So the requirement is implemented as: **transcribe turn-taking accurately, and never present overlapped audio as if it were accurate.**

### 8b. Transcription

- Enable Speechmatics diarization (`diarization="speaker"`) for conversation mode only. Single-voice capture keeps it off
- Speaker labels return generic (Speaker 1, Speaker 2). Allow inline rename, applied across the note
- Renames are per-note and ephemeral. **Never enrolled as a voiceprint, never carried across sessions**
- Contiguous speaker turns rendered as blocks, not per-sentence labels

### 8c. Overlap handling

- Detect regions the diarizer flags as simultaneous speakers
- Render those segments visually distinct with a marker such as "two people speaking" rather than emitting a confident single-speaker transcript
- Tapping the marker plays that audio segment. The recording is the ground truth; route the user to it instead of guessing
- **Never attach a speaker label to a commitment or action item extracted from an overlapped region**
- Surface low-confidence segments throughout, not only in overlap

### 8d. Consent prompt

Full spec in [plan/11-consent-prompt.md](plan/11-consent-prompt.md). Core requirements:

- Fires **before** the microphone opens, blocking, every session. Never for ordinary single-voice capture
- Copy: *"Does everyone here know you're recording?"* → *"Yes, start recording"* / *"Not yet"*
- "Not yet" offers single-voice mode instead, or back. Never nag, never re-prompt in session
- Optional audible announcement at session start. This is the more genuinely protective feature, since it actually informs the other people
- Log locally: timestamp, choice, whether announcement played. **Local only, never sent to the server**
- Separate one-time prompt at first audio export, defaulting share to transcript-only

### 8e. Retention inversion

Conversation-mode audio deletes within 24 hours or immediately, overriding the 30-day default. The recording contains other people's voices and those people agreed to nothing.

**Rule:** your own voice you keep, other people's you don't.

### 8f. Session cap

45 to 60 minutes. A note-taking app has no reason to record for three hours, and the cap makes intended use legible.

**Done when:** a two-person turn-taking conversation produces a usable labelled transcript, overlapped passages are marked rather than fabricated, consent fires every session, and audio is gone within 24 hours.

**Prerequisite:** legal review. Australian recording law varies by state and published summaries contradict each other. The app must not attempt jurisdiction-specific legal guidance.

---

## Milestone 9: Privacy policy

**Spec:** [plan/07-privacy-policy.md](plan/07-privacy-policy.md)
**Effort:** half a day plus legal review
**Depends on:** M2, M5

Speechmatics is a data processor, which makes **Nueco the data controller**. End-user deletion requests are your obligation to fulfil, not theirs.

- Sign a DPA with Speechmatics before launch
- Build a user-facing deletion path
- Name the subprocessor: Cantab Research Limited, England and Wales
- Draft copy is in the spec file. **Every sentence in it is only true once the corresponding milestone ships.** Do not publish ahead of the code

---

## Sequence

```
M1 Abstraction ──→ M2 Speechmatics ──→ M3 Shadow + cutover ──→ M9 Privacy policy
                          │
                          └──────────────┐
M4 VAD          (parallel, no deps)      │
M5 Retention    (parallel, no deps) ─────┼──→ M6 Note editor player  [REQ 1]
M7 Controls     (parallel, no deps) ─────┘         │
                                                    ↓
                                      M8 Conversation mode  [REQ 2]
                                      (+ legal review)
```

**Critical path to Requirement 1:** M5 → M6. Roughly 4 days. M2 only affects tap-to-seek.

**Critical path to Requirement 2:** M2 → M7 → M8, plus legal. Roughly 3 weeks.

**Start today:** M1 and M4 in parallel. Neither blocks on anything and both are half-day tasks.

---

## What was dropped

The Phase 0 evaluation gate. Speechmatics is decided on the retention argument, which does not depend on benchmark outcomes: OpenAI's court-ordered retention means you currently cannot write an accurate privacy policy claiming user audio is not retained by a third party, and ZDR is unavailable at your tier.

Shadow mode in M3 retains the safety net. If Speechmatics turns out slower or hallucinates on real audio, you find out with the OpenAI path still live and a one-line rollback.

Rejected alternatives and their revisit triggers: [plan/12-appendices.md](plan/12-appendices.md).
