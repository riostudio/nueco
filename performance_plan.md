# Nueco performance plan

Stack: React Native / Expo client, FastAPI on Railway, MongoDB Atlas, offline sync, RevenueCat.

Goal: nothing in the user's critical path waits on a network call or a model call.

## Principles

These are non-negotiable. If a change violates one of these, it is the wrong change.

1. **Capture is sacred.** Nothing is ever added between the user's thought and the note being saved. No prompt, no spinner, no confirmation.
2. **Local first.** Add, edit and delete write to local storage and update the UI immediately. The network is a background concern.
3. **AI runs on the write path, never the read path.** Enrichment happens once per note, asynchronously. Ranking at read time is deterministic arithmetic with no model call.
4. **Degrade to a plain notes app.** If transcription or enrichment fails, the note still exists and the app still works. An AI failure must never look like data loss.
5. **Measure before optimising.** No performance change ships without a before and after number.

## Latency budgets

| Operation | Budget | Notes |
|---|---|---|
| Add note | 0ms perceived | Local write, UI updates immediately |
| Delete note | 0ms perceived | Tombstone locally, sync later |
| Note list render | < 100ms | From local cache |
| Daily Brew, warm start | < 300ms | Single indexed query |
| Cold start to first content | < 2s | Cached payload while fresh loads |
| Transcript, first words visible | < 1s | Streamed during recording |
| Enrichment complete | No budget | Invisible, background |

Anything over budget gets profiled. Anything under budget gets left alone.

---

## Phase 0: Instrument

Do this first and ship it. Everything after this phase is guesswork without it.

- [ ] Add FastAPI middleware logging route, duration, and user id for every request
- [ ] Log MongoDB query duration separately from total request duration
- [ ] Client: timestamp from user tap to first paint for add, delete, list open, Brew open
- [ ] Client: timestamp cold start from launch to first meaningful content
- [ ] Log token spend per user per day for every model call
- [ ] Run for 3 to 5 days before starting Phase 2

**Done when:** you can answer "what is our p95 Daily Brew load time" with a number rather than a guess.

---

## Phase 1: Server quick wins

These are cheap, low risk, and likely account for a large share of current latency.

- [ ] Confirm the Mongo client is a module-level singleton created once at startup, not per request
- [ ] Confirm Railway region and Atlas region match. Cross-region adds 100 to 300ms to every query
- [ ] Add compound index: `[("user_id", 1), ("state", 1), ("surface_after", 1), ("score", -1)]`
- [ ] Run `.explain()` on the Daily Brew query. If it shows COLLSCAN, the index is not being used
- [ ] Add projections to list queries so audio URLs and full transcripts are not returned in list views
- [ ] Check whether the Railway service sleeps on the current plan. If so, either upgrade or add a keepalive

**Done when:** Brew endpoint p95 under 300ms measured server-side.

---

## Phase 2: Optimistic UI

The biggest perceived win in the app. Add and delete should never show a loading state.

- [ ] Add note: write to local store, update UI, queue mutation, return immediately. Do not await network
- [ ] Delete note: set local tombstone with `deleted_at`, remove from view immediately, reconcile on sync
- [ ] Edit note: same pattern
- [ ] Audit every screen for spinners on user-initiated writes. Remove all of them
- [ ] Sync queue: coalesce and debounce. Batch pending mutations rather than firing per action
- [ ] Handle sync conflict with last-write-wins on `updated_at`. Do not surface conflicts to the user

**Done when:** airplane mode is indistinguishable from online for add, edit and delete.

---

## Phase 3: Cold start and Daily Brew

- [ ] Materialise `score` onto the note document when enrichment completes. Do not compute ranking at request time
- [ ] Brew endpoint becomes a single indexed find with sort and limit
- [ ] Cache last Brew payload locally. Render cached content instantly, revalidate in background
- [ ] Hold splash screen until first meaningful paint rather than showing an empty shell
- [ ] Confirm Hermes is enabled
- [ ] Lazy-import anything not required for the first screen
- [ ] Replace FlatList with FlashList if list scroll is janky
- [ ] Precompute the next Brew overnight so morning open is a read, not a generation

**Done when:** cold start to first visible content under 2s on a mid-range Android device.

---

## Phase 4: Transcription perceived latency

The only place where the model is genuinely the bottleneck. The fix is perceptual.

- [ ] Chunk and stream audio during recording rather than uploading after the user stops
- [ ] Show partial transcript text as it arrives
- [ ] Hybrid: on-device pass for instant rough text so the note is never empty, server pass for the accurate version that replaces it
- [ ] Never show a "processing" state on a note the user opens. Show raw transcript if enrichment is not done

**Done when:** first words appear on screen within 1s of the user starting to speak.

---

## Phase 5: Enrichment pipeline

- [ ] `POST /notes` writes raw transcript, sets `enrichment_status: "pending"`, returns immediately
- [ ] Background enrichment via FastAPI BackgroundTasks
- [ ] Sweeper job picks up anything stuck in `pending` older than 5 minutes. Makes recovery idempotent and catches offline-synced notes
- [ ] One structured LLM call per note returning: `type`, `title`, `first_step`, `people`, `inferred_due`, `effort_minutes`, `surface_after`, `confidence`
- [ ] Cheap fast model for classification, stronger model only for drafting
- [ ] Batch enrichment when several notes arrive together
- [ ] Draft generation is lazy: only when a card is actually surfaced. Cache the draft on the note
- [ ] `enrichment_status: "failed"` with retry. Raw note always remains readable

**Done when:** capture returns in under 100ms regardless of enrichment state, and a forced model outage does not break the app.

---

## Out of scope

Do not do these yet. They are premature at current user volume.

- Celery, Redis, or any dedicated job queue
- Learned ranking weights. Hand-tune first, learn once there is deferral data
- Horizontal scaling or read replicas
- Caching layers beyond the local client cache
- Rewriting the sync engine

---

## Execution order

Phases 0 and 1 can run in parallel. Do not start Phase 2 until Phase 0 has produced data.

Ship each phase separately. Record the before and after number for each budget in the table above. If a phase does not move its number, revert it and find out why rather than stacking another change on top.
