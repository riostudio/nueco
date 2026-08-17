# Conversation mode: multi-voice capture

**Scope changed.** Previously conditional. Now specified, because it has been requested as a feature. Still requires a separate go decision and legal review before build.

## What is achievable, stated before the spec

The request was: capture multiple concurrent voices, transcribe overlapping speech accurately, and display each speaker's text separately.

**The overlapping part cannot be built to that standard.** This is not an implementation gap, it is the current state of the field.

The numbers: an ASR system achieving 5.5% WER on single-speaker audio can produce 84.7% WER on two-speaker overlapped speech. That is not a degraded transcript, it is unusable output.

Research approaches exist — permutation invariant training, serialized output training, target-speaker ASR — but they are not available in any commercial API, and their performance degrades on single-talker ASR, which is Nueco's primary case. PIT additionally constrains the maximum speaker count by the number of output branches and struggles with permutation and speaker tracking over long audio.

Speechmatics diarization does **not** separate overlapping speech into parallel streams. Like all standard diarization, it assigns one speaker per frame. During overlap it will pick one, or produce garbled text, and it will not tell you which.

**So the honest capability statement is:**

| Situation | Achievable |
|---|---|
| People taking turns, minimal overlap, moderate noise | Yes. Speaker labels roughly reliable, transcript usable |
| Brief interruptions and back-channel ("mm-hmm", "yeah") | Mostly. Expect occasional misattribution |
| Sustained simultaneous speech, two people talking over each other | **No.** Output will be wrong and will not announce that it is wrong |
| Noisy room plus overlap together | **No.** Worst case for every system available |

## The design response: fail visibly

Since overlap cannot be transcribed accurately, the product requirement changes from "transcribe it accurately" to "never present overlapped audio as if it were accurate." That is achievable and it is the version worth building.

- [ ] **Overlap detection.** Flag regions where the diarizer indicates simultaneous speakers. pyannote-style overlap detection is separate from separation and is tractable
- [ ] **Mark, do not fabricate.** In flagged regions, render the segment visually distinct with a marker like "two people speaking" rather than emitting a confident single-speaker transcript
- [ ] **Tap the marker to hear that segment.** The audio is the ground truth. Route the user to it instead of guessing on their behalf
- [ ] **Never silently attribute.** A commitment or action item extracted from an overlapped region must not carry a speaker label
- [ ] **Confidence surfacing.** Low-confidence segments visually distinguished throughout, not just in overlap

## What to tell the user

- [ ] First-run explanation before the first conversation session: works best when people take turns, will mark passages where voices overlap, keeps the audio so anything unclear can be checked
- [ ] Do not market this as accurate multi-speaker transcription. Setting the expectation correctly is the difference between a useful tool and a broken one

## Speaker display

- [ ] Speaker labels come back as generic ("Speaker 1", "Speaker 2"). Let the user rename them inline, once, applied across the note
- [ ] Renames are per-note and ephemeral. Never enrolled as a voiceprint or carried across sessions
- [ ] Grouped display: contiguous speaker turns as blocks, not per-sentence labels

## Positioning

Do not compete on attribution accuracy. Even dedicated multi-microphone hardware reports roughly 80% speaker label accuracy in clear English and good conditions, after manual tagging, and Nueco on a phone mic will be worse.

The wedge is the appointments where a neurodivergent adult cannot listen and take notes simultaneously: GP consults, NDIS planning meetings, parent-teacher interviews, work 1:1s. In those, "what did I agree to and what happens next" matters far more than "who said which sentence." That reframes diarization from a correctness problem into a soft structuring signal, which is winnable.

**Technical note:** Speechmatics has diarization built in, so this is a config change rather than a new vendor. That is a real advantage of the Speechmatics path over self-hosting, where diarization would require WhisperX and pyannote on top.

## Required controls if built

- [ ] One-tap consent prompt before every conversation-mode session, not once at onboarding. Suggested copy: "Everyone here knows you're recording?" with a single confirm action
- [ ] Log that confirmation locally with a timestamp. Not a legal shield, but it evidences intent and changes user behaviour
- [ ] Inverted retention default: conversation-mode audio deletes within 24 hours or immediately. The recording contains other people's voices, and those people agreed to nothing
- [ ] Session length cap of 45 to 60 minutes
- [ ] Speaker labels ephemeral and per-session only, never enrolled or persisted
- [ ] Speaker labels presented as editable suggestions. Never silently attribute a commitment to the wrong person
- [ ] Correction must be a single tap

**Retention rule, stated simply:** your own voice you keep, other people's you don't.

## Prerequisite

Legal review specific to conversation mode before any build work. Australian recording law varies by state and the split is not intuitive: Victoria, Queensland and the Northern Territory do not extend the offence to a participant's own recording; New South Wales, Tasmania and the ACT have a personal-use exception; Western Australia and South Australia require consent or a specific lawful-interest justification. Published summaries contradict each other, which is itself a reason not to encode legal logic into the app. Play Store distribution also means exposure to all-party-consent jurisdictions overseas.

**The app should not attempt to give jurisdiction-specific legal guidance.** Consent-forward design plus clear terms is the correct posture.

---
