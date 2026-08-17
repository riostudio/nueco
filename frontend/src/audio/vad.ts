/**
 * Client-side voice activity detection for upload-size reduction (plan.md M4).
 *
 * Strategy: SEGMENT, DO NOT STRIP. Natural pauses under ~0.9s stay in the recording -
 * they carry the rhythm the transcription model uses for sentence boundaries and
 * punctuation. Only EXTENDED silence pauses the recorder; the gap is then absent from
 * the file entirely, which is what shrinks the upload. Because metering stops while the
 * recorder is paused, the controller probes: periodically resume briefly, listen, and
 * re-pause if still silent - so it can never get stuck paused when the user starts
 * speaking again.
 *
 * Pure logic, no react/react-native imports (see AGENTS.md clean-architecture rules).
 * The recorder wiring in app/editor.tsx applies the actions this module returns.
 */

export type VadState = 'listening' | 'paused' | 'probing';
export type VadAction = 'pause' | 'resume' | null;

export interface SilencePauseConfig {
  /** dBFS below which a sample counts as silence. */
  silenceThresholdDb: number;
  /** dBFS above which a sample counts as speech while deciding to resume (hysteresis -
   * deliberately higher than silenceThresholdDb so ambient noise doesn't flap the state). */
  resumeThresholdDb: number;
  /** Sustained silence required before pausing. Pauses shorter than this are recorded as
   * normal - they're part of how speech is structured. */
  minSilenceToPauseMs: number;
  /** While paused, how often to resume briefly and listen for speech. */
  probeIntervalMs: number;
  /** How long a probe listens before concluding it's still silent and re-pausing. */
  probeWindowMs: number;
  /** Don't pause until the user has actually spoken once - a fresh recording with nothing
   * said yet should stay armed rather than immediately dropping into pause. */
  armOnFirstSpeech: boolean;
}

export const DEFAULT_SILENCE_PAUSE_CONFIG: SilencePauseConfig = {
  silenceThresholdDb: -42,
  resumeThresholdDb: -38,
  minSilenceToPauseMs: 900,
  probeIntervalMs: 1500,
  probeWindowMs: 450,
  armOnFirstSpeech: true,
};

export interface SilencePauseVad {
  state: VadState;
  /** Feed one metering sample (dBFS; undefined/NaN treated as silence). Returns the action
   * the caller must apply to the recorder right now, if any. */
  process(dbfs: number | undefined, tsMs: number): VadAction;
  /** While paused: true once it's time to probe. Calling this transitions to 'probing' -
   * the caller must resume the recorder and keep feeding samples via process(). */
  shouldProbe(tsMs: number): boolean;
  reset(): void;
}

export function createSilencePauseVad(
  config: SilencePauseConfig = DEFAULT_SILENCE_PAUSE_CONFIG,
): SilencePauseVad {
  let state: VadState = 'listening';
  let armed = !config.armOnFirstSpeech;
  let silenceStart: number | null = null;
  let pausedAt = 0;
  let probeStart = 0;

  const isSpeech = (dbfs: number | undefined, threshold: number): boolean =>
    dbfs != null && Number.isFinite(dbfs) && dbfs >= threshold;

  return {
    get state() {
      return state;
    },

    process(dbfs, tsMs) {
      if (state === 'listening') {
        if (isSpeech(dbfs, config.silenceThresholdDb)) {
          armed = true;
          silenceStart = null;
          return null;
        }
        if (!armed) return null;
        if (silenceStart === null) silenceStart = tsMs;
        if (tsMs - silenceStart >= config.minSilenceToPauseMs) {
          state = 'paused';
          pausedAt = tsMs;
          silenceStart = null;
          return 'pause';
        }
        return null;
      }

      if (state === 'probing') {
        if (isSpeech(dbfs, config.resumeThresholdDb)) {
          state = 'listening';
          silenceStart = null;
          return 'resume';
        }
        if (tsMs - probeStart >= config.probeWindowMs) {
          state = 'paused';
          pausedAt = tsMs;
          return 'pause';
        }
        return null;
      }

      // paused: metering is stale while the recorder is paused - ignore samples; the probe
      // cycle (shouldProbe -> resume -> process) is the only way back to listening.
      return null;
    },

    shouldProbe(tsMs) {
      if (state !== 'paused') return false;
      if (tsMs - pausedAt < config.probeIntervalMs) return false;
      state = 'probing';
      probeStart = tsMs;
      return true;
    },

    reset() {
      state = 'listening';
      armed = !config.armOnFirstSpeech;
      silenceStart = null;
      pausedAt = 0;
      probeStart = 0;
    },
  };
}
