# Audio player in the note editor

The recording is a first-class element of the note, not a hidden backup. Layout is: audio player at the top of the note body, transcript directly beneath it.

**Player component**

- [ ] Renders at the top of the note editor immediately after capture completes, before the user has done anything else
- [ ] Play / pause, scrubber, elapsed and total duration
- [ ] Waveform or amplitude bars. Cheap to render from the Opus file and makes silence and speech visually distinguishable, which helps when checking a suspect transcript
- [ ] Playback speed control (1x, 1.5x, 2x). Low effort, disproportionately useful when re-checking a long note
- [ ] Persist and restore playback position within a session
- [ ] Continues playing if the user scrolls or edits the transcript

**Transcript below the player**

- [ ] Editable text directly under the player, visually grouped as one unit rather than two separate cards
- [ ] Tapping a word seeks the audio to that point, if word-level timestamps are available from the provider. Speechmatics returns word-level items, so this is close to free once the flattener keeps the timing data. **Do not discard timestamps in the flattener** (see 7.2)
- [ ] Show which words the user has edited, so a corrected transcript is distinguishable from a raw one

**Export**

- [ ] Download / share the audio file to device storage, standard Android share sheet
- [ ] Filename includes note title and capture date, not a UUID
- [ ] Export the transcript as text separately, so the common case (share the words) does not require sharing the audio
- [ ] **First-time export warning if the note came from conversation mode.** Exporting audio containing other people's voices is the higher-risk act in several Australian jurisdictions. See 8.3

**Expiry**

- [ ] When local audio has passed the retention window, the player is replaced by a plain line explaining the audio expired and how to change the setting
- [ ] Warn before expiry on any note the user has edited or starred, since those are the ones they care about

**Why this matters:** the failure mode is not a missing note, it is a fluent, confident, wrong note the user does not question. Local audio is the only recovery path. This matters more for a user who captured the thought precisely because they knew they would lose it.
