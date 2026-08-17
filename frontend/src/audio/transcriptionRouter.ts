/**
 * Cloud-vs-on-device transcription router - the single seam every capture path uses.
 *
 * Online: the existing cloud path (Speechmatics via /transcribe-base64) keeps winning. It
 * returns word timestamps and speaker labels, and nothing about it should regress just
 * because an offline engine now exists.
 *
 * Offline: whisper.cpp on-device (offlineTranscription.ts). The result carries no word
 * timings and no diarization - callers must treat `words` as optional, which the editor
 * and onboarding already do for the no-speaker-labels case.
 *
 * Offline with no model downloaded: ModelNotReadyError, which call sites turn into a
 * one-tap path to Settings. Silently queueing audio for later would break the "you get
 * your words back" promise this app is built on.
 */
import { transcribeApi } from '../api';
import type { WordTiming } from './retention';
import { isOnline } from '../offlineSync';
import { ModelNotReadyError, getModelState, refreshModelState, transcribeOffline } from './offlineTranscription';

export interface TranscriptionResult {
  text: string;
  words?: WordTiming[];
  engine: 'cloud' | 'local';
}

export { ModelNotReadyError };

export async function transcribeAudio(
  fileUri: string,
  opts: { diarization?: string } = {},
): Promise<TranscriptionResult> {
  if (await isOnline()) {
    const result = await transcribeApi.transcribe(fileUri, opts);
    return { ...result, engine: 'cloud' };
  }
  // Derive state from disk first: on a cold start the in-memory state is not_downloaded even
  // when the model file is present.
  await refreshModelState();
  if (getModelState().state !== 'ready') {
    // Offline and no model: there is nothing to fall back to.
    throw new ModelNotReadyError();
  }
  const result = await transcribeOffline(fileUri);
  return { text: result.text, engine: 'local' };
}
