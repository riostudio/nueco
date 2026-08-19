# Consent prompt specification

**What this is, precisely.** The app cannot obtain consent from the other people in the room. It can only ask the user to attest that they have told them. This is an **attestation**, not consent, and the spec should be honest about that internally even if the user-facing copy is simpler.

Its value is real but modest: it changes user behaviour, it makes covert use feel deliberate rather than incidental, and it creates a local record of intent. It does not make a recording lawful.

**Timing and blocking**

- [ ] Fires **before** the microphone opens, not after recording starts. A prompt shown over a live recording is worthless
- [ ] Blocking. Cannot be dismissed by tapping outside or hitting back
- [ ] Every conversation-mode session. Not once at onboarding, not once per day
- [ ] Does **not** fire for normal single-voice capture. Conversation mode only. Adding friction to ordinary voice notes would damage the core product

**Copy**

Primary: *"Does everyone here know you're recording?"*

Two actions:
- *"Yes, start recording"*
- *"Not yet"*

Notes on the copy:
- Question, not a checkbox. A checkbox reads as a liability waiver; a question reads as a reminder, which is what it is
- "Everyone here" rather than "all participants". Plain language
- Avoid the word consent in the UI. It implies legal weight the prompt does not carry
- Avoid warnings, legal framing, or anything that reads as a threat. The user is likely about to walk into a medical appointment. Do not add anxiety

**If they choose "Not yet"**

- [ ] Do not just cancel. Offer two paths: start single-voice mode instead (their own voice, no conversation capture), or go back
- [ ] Optionally offer the audible announcement below as a way to disclose
- [ ] Never nag, never re-prompt in the same session, never show a persuasion screen

**Audible announcement (optional, and more genuinely protective than the prompt)**

- [ ] Setting: on starting conversation mode, play a short spoken line at audible volume, e.g. *"Recording started for note-taking."*
- [ ] Default off, but surfaced during first-run
- [ ] This is worth building because it actually informs the other people, which the prompt does not. For a user who finds it hard to interrupt a doctor to say "I'm going to record this", it does the disclosure for them
- [ ] Also serves as the audible start chime required in 8.2

**Anti-habituation**

Real tension here: a prompt shown every session becomes a reflex tap within a week, at which point it stops doing anything.

- [ ] Do not solve this with added friction (hold-to-confirm, typing, multiple taps). The user may be stressed, in a waiting room, with the appointment starting. Cognitive load is a real cost for this audience
- [ ] Instead: make the *outcome* visible. Show in the note itself that the recording was disclosed, and show a running count in Settings. Visible consequence sustains attention better than added effort
- [ ] Revisit after real usage data. This is a hypothesis, not a settled answer

**Logging**

- [ ] Store locally alongside the note: timestamp, which option was chosen, whether the audible announcement played
- [ ] **Local only. Never sent to the server.** This is a record for the user, not telemetry about the user
- [ ] Visible in note details, not buried. The user should be able to see what they confirmed
- [ ] Include in the note export so the record travels with the recording

**Separate consent at the sharing step**

Recording and sharing are distinct acts, and in several Australian jurisdictions sharing is the more restricted one.

- [ ] First time a user exports or shares audio from a conversation-mode note, a separate one-time prompt: sharing a recording of other people is different from keeping it for yourself
- [ ] One-time, not every share. This one is about awareness, not per-act attestation
- [ ] Default the share action to transcript-only, requiring a deliberate extra step to include audio

**Explicitly not doing**

- Jurisdiction detection or location-based legal guidance. Australian recording law varies by state, published summaries contradict each other, and getting it wrong is worse than not offering it. The app is not a legal advisor
- Storing anything about the other people in the room
- Blocking recording based on the attestation. The app asks, it does not police
