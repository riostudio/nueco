# Speechmatics migration

**Blocked by Phase 0.**

Verify all API specifics against current Speechmatics docs before implementing. Details below are a sketch, not a spec.

## Abstraction layer first

- [ ] Extract the transcription call behind a provider interface: audio in, plain text plus optional metadata out
- [ ] Implement the existing OpenAI path against it
- [ ] Confirm no behaviour change, deploy, verify in production

Do this before touching Speechmatics. It makes the swap a config change and gives a one-line rollback. Useful whether or not you ever migrate.

## Speechmatics implementation

- [ ] Add the Speechmatics Python batch client
- [ ] API key in Railway environment variables, never committed
- [ ] Implement the provider interface. Roughly: `TranscriptionConfig`, then `client.transcribe(audio_file=..., transcription_config=config)`, then read the transcript text
- [ ] Set language explicitly to `en` rather than relying on auto-detect
- [ ] **Do not enable diarization.** Not needed, adds latency
- [ ] Write the response flattener: Speechmatics returns structured JSON with word-level items, the downstream schema-structuring step expects flat text
- [ ] **Preserve word-level timestamps alongside the flat text.** The note editor player (6.3) uses them for tap-a-word-to-seek. Discarding them here means rebuilding this later
- [ ] Handle the async job model. The SDK wraps polling, but measure end-to-end wall-clock latency, not API response time
- [ ] Error handling: rate limits (documented at 10 jobs/second on `POST /v2/jobs`), timeouts, malformed audio. Exponential backoff with jitter, capped retry budget
- [ ] Confirm current audio upload format passes through unchanged
- [ ] **Call DELETE on the job immediately after retrieving the transcript.** Non-optional. Takes effective retention from 7 days to seconds and is what makes the privacy claim strong. Put it in a `finally` block so it runs on error paths, and log failures loudly. A delete that silently fails leaves audio sitting for a week
- [ ] Add a reconciliation job: list any jobs older than a few minutes and delete them, catching cases where the inline delete failed

## Cutover

- [ ] Feature flag: provider selectable per-request via environment config
- [ ] Shadow mode: run both providers on a sample of real traffic, log both transcripts, compare offline for one week
- [ ] Review shadow results before flipping the default
- [ ] Flip default, keep the OpenAI path intact for 30 days
- [ ] Remove the dead path only after 30 days of clean production data

## Cost check

- [ ] Confirm current pricing directly. Speechmatics moved to credit-based billing from 1 August 2026
- [ ] Compare against current monthly OpenAI transcription spend
- [ ] Expected outcome: modest saving. If it is a cost increase, that is still acceptable given the retention rationale, but note it explicitly

**Estimated effort:** half a day for 7.1 and 7.2, plus a week of shadow running.

---
