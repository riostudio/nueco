# Nueco On-Device AI Agent — Design

**Status:** Draft / planning. Not yet implemented.
**Related:** [E2EE-DESIGN.md](./E2EE-DESIGN.md), [CALENDAR-REMINDERS-DESIGN.md](./CALENDAR-REMINDERS-DESIGN.md)

---

## 1. Goal

A local assistant that helps the user **organize** (tag, link, group, summarize notes and events) and **recall** ("what did I note about X?", "what did I plan around Y?") — running **entirely on-device**: offline, private, and GDPR-clean.

The design leverage the fact that Nueco is already **E2EE**: notes are decrypted in the local cache, so the plaintext the agent needs is *already on the device*. Processing it locally means **nothing leaves the phone** — which both delivers the privacy promise and removes the current plaintext egress to OpenAI (today's biggest compliance gap).

### Non-goals (v1)
- No cloud inference by default (a consented hybrid mode is a possible later add — §12).
- No autonomous actions: the agent **suggests**, the user **confirms** (keeps us out of GDPR Art. 22 territory).
- Not a general chatbot; scoped to the user's own notes/events/calendar.

---

## 2. Principles

1. **On-device only.** Inference, embeddings, and the vector index all run/live locally. No network in the AI path.
2. **Encrypted at rest.** The vector index is derived from plaintext and can leak content (embedding-inversion) — it is treated as sensitive as the notes and encrypted with the E2EE-derived key / device keystore.
3. **Human-in-the-loop.** Every mutating action (tag, link, create event) is a suggestion the user accepts.
4. **Minimize + let users opt out.** Index only what's needed; per-note "exclude from AI" flag.
5. **Erasable.** Account deletion and logout wipe the index + model cache alongside the note cache.

---

## 3. Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  DEVICE                                                       │
│                                                               │
│  decrypted notes + events  (offlineSync: getLocalNotes/Events)│
│            │                                                  │
│            ▼  chunk + embed (on-device embedding model)       │
│   ┌──────────────────────────┐                                │
│   │ Encrypted vector index   │  sqlite-vec, key-wrapped       │
│   │  (chunks + float32 vecs) │                                │
│   └──────────────────────────┘                                │
│            │  semantic search (top-k)                         │
│            ▼                                                   │
│   ┌──────────────────────────┐   grammar-constrained JSON     │
│   │  On-device LLM (Q4)       │──────────► Tool registry ──┐   │
│   │  (llama.rn / ExecuTorch)  │            (typed local fns)│   │
│   └──────────────────────────┘                            │   │
│            │  grounded answer / suggestion                 ▼   │
│            ▼                            eventsApi · tagging ·   │
│         UI (recall chat, suggestion cards)   calendar write    │
└─────────────────────────────────────────────────────────────┘
```

---

## 4. Component choices

| Layer | Choice | Rationale |
|---|---|---|
| **Inference runtime** | `react-native-executorch` **or** `llama.rn` (llama.cpp/GGUF) | Cross-platform, dev-client compatible (we already do local EAS builds). `llama.rn` supports **GBNF grammars** → reliable JSON from small models. |
| **Platform-native (optional fast path)** | Apple **Foundation Models** (iOS 18.1+) / **Gemini Nano** (ML Kit / MediaPipe, some Android) | Best battery/latency where present; Android availability is fragmented, so the bundled model stays the baseline. |
| **LLM** | Llama 3.2 3B / Qwen2.5 1.5B / Gemma 2 2B / Phi-3.5-mini, **Q4** (~1–2 GB) | Runs on mid-range phones (CPU-bound). Enough for tagging, summarizing, tool-routing. |
| **Embeddings** | MiniLM-L6 / bge-small (384-dim) | Small, fast; the workhorse for recall. |
| **Vector store** | `sqlite-vec` via `op-sqlite` | Vector search in SQLite; scales to thousands of notes; one file to encrypt. |
| **Transcription** | `whisper.rn` (whisper.cpp) | Replaces OpenAI Whisper → voice notes fully local (ties into voice-reminder Phase 3). |

---

## 5. Encrypted index schema

A single SQLite DB (`nueco/ai-index.db` under the offlineSync `FILE_DIR`), encrypted at rest (SQLCipher via op-sqlite, or app-level field encryption with the E2EE key).

```
chunks(
  id TEXT PRIMARY KEY,
  source_type TEXT,        -- 'note' | 'event'
  source_id TEXT,          -- note.id / event.id
  chunk_ix INTEGER,        -- position within the source
  text TEXT,               -- plaintext chunk (encrypted at rest)
  updated_at TEXT,         -- for incremental re-index
  content_hash TEXT        -- skip re-embedding unchanged chunks
)
vec_chunks(                -- sqlite-vec virtual table
  chunk_id TEXT,
  embedding FLOAT[384]
)
meta(
  model_id TEXT,           -- embedding model + version (re-index on change)
  index_version INTEGER
)
```

**Key management:** the DB encryption key is derived from / wrapped by the existing E2EE key material (see E2EE-DESIGN) or stored in `expo-secure-store` (Keychain / Keystore). Never persisted in plaintext.

---

## 6. Ingest / indexing pipeline

- **Trigger:** on note/event create/update (debounced), and a full reconcile after `syncAndReload`.
- **Chunking:** notes → ~200–400 token chunks on paragraph boundaries (reuse `plainTextFromContent` to strip HTML); events → one chunk from title + description + time.
- **Incremental:** skip chunks whose `content_hash` is unchanged; delete chunks for removed/`_pendingDelete` sources.
- **When:** heavy first-index runs on **charge + Wi-Fi**; incremental updates are cheap.
- **Opt-out:** notes flagged "exclude from AI" are never chunked/embedded.

---

## 7. Recall

1. Embed the query on-device.
2. Top-k semantic search over `vec_chunks` (+ optional recency/pin boost, tag filters).
3. Two modes:
   - **Extractive** (fast, no LLM): return the matching notes/events with highlighted snippets.
   - **Synthesized** (LLM): feed top-k chunks as grounded context → short answer **with citations back to the source notes** (never free-hallucinate; cite or say "not found").

---

## 8. Organize

Background, human-confirmed suggestions:
- **Tagging:** propose tags from content; user taps to accept.
- **Linking:** notes ↔ events (e.g., a note that mentions a meeting → link to the calendar event) using semantic similarity + the LLM.
- **Summaries / grouping:** thread/cluster related notes; summarize on demand.

Surfaced as **suggestion cards** the user accepts/dismisses — no silent writes.

---

## 9. Agentic tool-use

A minimal loop (no heavyweight framework): `retrieve → prompt → optional tool call → execute → observe → respond`.

- **Constrained output:** the LLM emits JSON matching a **GBNF grammar** (llama.cpp) so even a small model reliably produces valid tool calls.
- **Tool registry:** typed local functions, each with a schema. Reuse what already exists:
  - `search_notes(query)` → the recall path
  - `create_event({title,start,end,reminder})` → `eventsApi.create` + `expo-calendar` write
  - `tag_note(noteId, tags)` / `link(noteId, eventId)`
  - `summarize(sourceIds)`
- **Guardrail:** mutating tools return a **proposed** action rendered as a confirmation card; nothing executes without a tap.

---

## 10. Security & privacy

- **No egress.** Model + embeddings + store are all local; the AI path makes zero network calls.
- **Encryption at rest** for the index (§5) — the critical, non-obvious requirement (embeddings ≈ content).
- **Erasure:** extend `clearLocalData()` to delete `ai-index.db` + downloaded model files; wipe the index key from secure store. Wire into account deletion + logout.
- **Model integrity:** download models over HTTPS from a pinned source with a checksum; store under app sandbox.
- **Consent for model download** (0.5–2 GB) over Wi-Fi.

---

## 11. GDPR mapping

| Requirement | How on-device satisfies it |
|---|---|
| **Lawful basis / minimization** (Art. 5–6) | Only the user's own data, processed locally; per-note opt-out. |
| **No third-party processor / transfer** (Art. 28/44) | Inference is on-device → OpenAI (and its international transfer) drops out of the AI flow entirely. |
| **Transparency** (Art. 13) | Disclose "on-device AI processing" in the privacy policy — even though nothing leaves the phone. |
| **Erasure** (Art. 17) | Account deletion wipes index + model cache + index key (§10). |
| **Automated decisions** (Art. 22) | Human-in-the-loop: agent suggests, user confirms. |
| **DPIA** | Advisable (AI + possibly special-category note content), but on-device keeps residual risk low. |

**Bonus:** migrating transcription + text-processing to on-device (whisper.rn + local LLM) *closes the existing plaintext-egress gap* — the current OpenAI calls are the main thing the privacy policy has to disclose today.

---

## 12. Open decisions

1. **Pure-local vs. hybrid.** Default **pure-local**. A later hybrid mode (bigger cloud model behind an explicit per-use consent toggle) would reintroduce processor/egress considerations — only if quality demands it.
2. **Runtime:** `llama.rn` (grammar-constrained tool calls, mature GGUF) vs `react-native-executorch` (Expo-aligned, embeddings + LLM in one). Prototype both for the embedding path.
3. **Index encryption:** SQLCipher (whole-DB) vs app-level field encryption with the E2EE key.
4. **Model distribution:** bundle a tiny embedding model in the build; download the LLM on first use.

---

## 13. Phased rollout

1. **Recall via embeddings** — on-device embedding model + encrypted `sqlite-vec` index + semantic search (extractive). Highest value, no LLM required.
2. **Organize** — on-device LLM for tag/link/summarize suggestions (human-confirmed).
3. **Agentic tool-use** — grammar-constrained tool calls into the existing local functions.
4. **Local transcription/text-processing** — whisper.rn + local LLM; retire the OpenAI calls → closes the GDPR egress gap.

Each phase needs a dev-client rebuild (native modules) but no backend changes — the whole thing is client-side, consistent with the E2EE "plaintext never leaves the device" model.
