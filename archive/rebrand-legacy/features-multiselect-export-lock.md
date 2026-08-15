# Nueco: multi-select, export, lock

Three features. Multi-select and export are low risk. Lock has a design decision that must be made before any code is written.

Applies the same principles as `plan.md`: local first, nothing blocks on the network, degrade gracefully.

---

## 1. Multi-select

### Interaction

Standard Android pattern. Long-press a note to enter selection mode. Tap to toggle. Contextual action bar replaces the header with count, select all, and the available actions. Back button or X exits.

Selection state is ephemeral UI state. Never persist it, never sync it.

### Bulk delete

- [ ] Long-press enters selection mode, tap toggles, count shown in header
- [ ] Select all / deselect all
- [ ] Delete writes local tombstones for all selected notes at once and updates the UI immediately
- [ ] One batched API call for the whole set, not one call per note
- [ ] **Undo is mandatory.** Snackbar with a 5 second window. Do not sync the delete until the window closes
- [ ] Cancel pending enrichment for any deleted note that has `enrichment_status: "pending"`. No point paying to enrich a deleted note
- [ ] Cap selection at a sane number (500) to avoid render stalls

Undo matters far more for bulk than for single delete. One accidental tap can wipe sixty notes, and without undo that is an uninstall.

### Grouping (tags)

Assumed interpretation: assign selected notes to a tag. Adjust if you meant collections or merging.

- [ ] Add `tags: [string]` to the note document
- [ ] Bulk action "Add tag" opens a picker with existing tags plus create new
- [ ] Tags are additive on bulk apply. Do not replace existing tags
- [ ] Filter the note list by tag
- [ ] Index: add `tags` to the compound index if tag filtering becomes a common query path
- [ ] Tags are local-first like everything else. Optimistic write, background sync

### Server

- [ ] `POST /notes/bulk-delete` accepting an array of ids
- [ ] `POST /notes/bulk-tag` accepting ids and a tag
- [ ] Both idempotent. Re-sending the same batch after a flaky connection must not error

---

## 2. Export

### Scope and format

Three scopes: single note, current selection, everything. Three formats:

| Format | Use case | Contains |
|---|---|---|
| Markdown | Sharing, moving to another app | Title, transcript, date, tags |
| Plain text | Quick paste | Transcript only |
| JSON | Backup and portability | Everything including enrichment fields |

Audio files are excluded by default. Add an "include audio" toggle only if users ask, since it makes exports large and slow.

### Implementation

- [ ] Single note and small selections: generate client-side, hand to the Android share sheet via `expo-sharing`
- [ ] Full export: generate server-side, since it may be large. Return a download link or email it
- [ ] Never block the UI on export generation. Show progress, allow cancel
- [ ] Filename convention: `nueco-export-YYYY-MM-DD.md`

### Why this matters beyond the feature

Data portability reduces lock-in anxiety, which is a real objection for a tool people are trusting with their commitments. It also covers you on data portability obligations under the Privacy Act and GDPR if you get international users.

Full JSON export is a reasonable paid-tier feature. Single note export should stay free, since gating basic sharing feels punitive.

---

## 3. Lock

### Decide this first

**Option A: biometric gate (recommended to ship first)**

Content stored as normal. Biometric or PIN prompt required to view. Locked notes hidden from the main list, search, and Daily Brew.

- Fast to build, no key management, no data loss risk
- AI features still work on locked notes
- Does **not** protect against device backup extraction or a server-side breach
- Must be named and described honestly. "Hidden" or "Private", not "Encrypted"

**Option B: real encryption**

Content encrypted client-side with a key held in Android Keystore via `expo-secure-store`.

- Actually protects the content
- Breaks enrichment, ranking, search and Daily Brew for locked notes
- Key loss on device change or reinstall means permanent data loss unless you build key backup
- Significant support burden

**Recommendation:** ship A, name it accurately, and only build B if users specifically ask for it. If B is ever built, treat it as a distinct mode with the AI tradeoff stated in the UI before the user commits.

### Implementation (Option A)

- [ ] Add `is_locked: bool` and `locked_at` to the note document
- [ ] `expo-local-authentication` for the biometric prompt, with device PIN fallback
- [ ] Lock and unlock available from single note actions and as a bulk action in selection mode
- [ ] Locked notes excluded from: main list, search results, Daily Brew, next-best-action ranking
- [ ] Separate "Locked" section requiring auth to open
- [ ] Re-auth required after app backgrounds for more than 60 seconds
- [ ] Locked note content excluded from export unless the user authenticates during the export flow
- [ ] Copy must be accurate. Something like "Hidden behind your device lock. Not encrypted." Do not overstate

### Explicitly out of scope for v1

- Per-note passwords separate from the device lock
- Encrypted sync
- Key backup and recovery

---

## Suggested build order

1. Multi-select with bulk delete and undo. Highest utility, lowest risk
2. Export. Self-contained, no interaction with other features
3. Tags. Touches the data model and the list query
4. Lock. Do the naming and scope decision before writing code

Each ships independently. Do not bundle them into one release.
