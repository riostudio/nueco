/**
 * On-device transcription with whisper.cpp (whisper.rn) for offline voice capture.
 *
 * The cloud path (POST /transcribe-base64) needs a connection; in airplane mode the app
 * falls back to this one. Everything happens on-device: the model lives in app storage,
 * audio is converted locally, and nothing about the capture leaves the phone - which also
 * means offline transcripts are never "upgraded" by re-upload (the guarantee in the
 * offline-capture design). Only the transcript TEXT of scheduling-looking captures gets
 * the queued cloud second pass (offlineSync's offlineClassifyQueue), same as the online
 * classifier already receives.
 *
 * Model: ggml-small-q5_1 (quantized multilingual "small" - ~181 MB, covers the app's
 * en + id spoken-language preference). Downloaded on demand from the Settings toggle;
 * state machine below drives that UI.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system/legacy';
import { FFmpegKit, ReturnCode } from 'ffmpeg-kit-react-native';
import { initWhisper, type WhisperContext } from 'whisper.rn/index';
import { getSpokenLanguagePref } from './recordingStore';

export const OFFLINE_TRANSCRIPTION_ENABLED_KEY = 'offline_transcription_enabled';

// Verified against huggingface.co/ggerganov/whisper.cpp (tree API) 2026-08-16.
const MODEL_FILENAME = 'ggml-small-q5_1.bin';
const MODEL_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small-q5_1.bin';
const MODEL_EXPECTED_BYTES = 190085487;

const MODELS_DIR = `${FileSystem.documentDirectory}nueco/models/`;
const MODEL_PATH = `${MODELS_DIR}${MODEL_FILENAME}`;
const DOWNLOAD_STATE_KEY = 'offline_model_download_state';

export type ModelState =
  | 'not_downloaded'
  | 'downloading'
  | 'ready'
  | 'error';

export interface ModelStateInfo {
  state: ModelState;
  /** 0..1 while downloading */
  progress: number;
  error: string | null;
}

export class ModelNotReadyError extends Error {
  constructor() {
    super('Offline transcription model is not downloaded');
    this.name = 'ModelNotReadyError';
  }
}

// ---- state machine ---------------------------------------------------------------------------

let current: ModelStateInfo = { state: 'not_downloaded', progress: 0, error: null };
let initialized = false;
const listeners = new Set<(info: ModelStateInfo) => void>();
let activeDownload: FileSystem.DownloadResumable | null = null;

function setModelState(patch: Partial<ModelStateInfo>) {
  current = { ...current, ...patch };
  for (const cb of listeners) cb(current);
}

export function getModelState(): ModelStateInfo {
  return current;
}

export function subscribeModelState(cb: (info: ModelStateInfo) => void): () => void {
  listeners.add(cb);
  cb(current);
  return () => listeners.delete(cb);
}

export async function isOfflineTranscriptionEnabled(): Promise<boolean> {
  return (await AsyncStorage.getItem(OFFLINE_TRANSCRIPTION_ENABLED_KEY)) === '1';
}

/** Derive initial state from disk. Called once from the Settings screen / app start. */
export async function refreshModelState(): Promise<void> {
  if (initialized) return;
  initialized = true;
  try {
    const info = await FileSystem.getInfoAsync(MODEL_PATH);
    if (info.exists && info.size === MODEL_EXPECTED_BYTES) {
      setModelState({ state: 'ready', progress: 1, error: null });
      return;
    }
    if (info.exists) {
      // Wrong size = torn download; start over rather than loading a corrupt model.
      await FileSystem.deleteAsync(MODEL_PATH, { idempotent: true });
    }
  } catch {
    // fall through: treat as not downloaded
  }
  setModelState({ state: 'not_downloaded', progress: 0, error: null });
}

// ---- download --------------------------------------------------------------------------------

async function runDownload(resumeFrom?: object) {
  await FileSystem.makeDirectoryAsync(MODELS_DIR, { intermediates: true }).catch(() => {});
  const download = FileSystem.createDownloadResumable(
    MODEL_URL,
    MODEL_PATH,
    {},
    p => {
      if (p.totalBytesExpectedToWrite > 0) {
        setModelState({ progress: p.totalBytesWritten / p.totalBytesExpectedToWrite });
      }
    },
  );
  activeDownload = download;
  try {
    let result;
    if (resumeFrom) {
      result = await download.resumeAsync();
    } else {
      result = await download.downloadAsync();
    }
    activeDownload = null;
    if (!result || result.status !== 200) {
      throw new Error(`Model download failed (HTTP ${result?.status ?? 'unknown'})`);
    }
    const info = await FileSystem.getInfoAsync(MODEL_PATH);
    if (!info.exists || info.size !== MODEL_EXPECTED_BYTES) {
      await FileSystem.deleteAsync(MODEL_PATH, { idempotent: true });
      throw new Error('Model download was incomplete');
    }
    await AsyncStorage.removeItem(DOWNLOAD_STATE_KEY);
    setModelState({ state: 'ready', progress: 1, error: null });
  } catch (e) {
    activeDownload = null;
    if ((e as Error)?.message?.includes('paused')) {
      // Paused by the user, not an error.
      setModelState({ state: 'not_downloaded', error: null });
      return;
    }
    // Persist resumable state so a later attempt continues instead of restarting 181 MB.
    try {
      const saved = download.pauseAsync ? await download.pauseAsync() : null;
      if (saved) await AsyncStorage.setItem(DOWNLOAD_STATE_KEY, JSON.stringify(saved));
    } catch {
      // pause on a failed download is best-effort
    }
    setModelState({ state: 'error', error: (e as Error)?.message || 'Download failed' });
    throw e;
  }
}

/** Start (or resume) the model download. Caller should have flipped the enabled toggle. */
export async function startModelDownload(): Promise<void> {
  if (current.state === 'downloading') return;
  setModelState({ state: 'downloading', error: null });
  let saved: object | undefined;
  try {
    const raw = await AsyncStorage.getItem(DOWNLOAD_STATE_KEY);
    if (raw) saved = JSON.parse(raw);
  } catch {
    saved = undefined;
  }
  await runDownload(saved);
}

export async function pauseModelDownload(): Promise<void> {
  if (activeDownload) {
    try {
      const saved = await activeDownload.pauseAsync();
      if (saved) await AsyncStorage.setItem(DOWNLOAD_STATE_KEY, JSON.stringify(saved));
    } catch {
      // pause is best-effort
    }
    activeDownload = null;
  }
  setModelState({ state: 'not_downloaded' });
}

export async function deleteModel(): Promise<void> {
  if (activeDownload) await pauseModelDownload();
  await releaseWhisperContext();
  await FileSystem.deleteAsync(MODEL_PATH, { idempotent: true });
  await AsyncStorage.removeItem(DOWNLOAD_STATE_KEY);
  setModelState({ state: 'not_downloaded', progress: 0, error: null });
}

// ---- transcription -----------------------------------------------------------------------------

let whisperContext: WhisperContext | null = null;

async function getContext(): Promise<WhisperContext> {
  if (whisperContext) return whisperContext;
  // whisper.rn wants a plain filesystem path, not a file:// URI.
  whisperContext = await initWhisper({ filePath: MODEL_PATH.replace(/^file:\/\//, '') });
  return whisperContext;
}

export async function releaseWhisperContext(): Promise<void> {
  if (whisperContext) {
    await whisperContext.release().catch(() => {});
    whisperContext = null;
  }
}

/**
 * Transcribe a recorded audio file entirely on-device.
 *
 * whisper.cpp only decodes 16-bit PCM WAV at 16 kHz, while expo-audio records m4a/AAC on
 * Android - so the recording is converted with ffmpeg-kit first (the "min" package: AAC
 * decode needs only FFmpeg core). The temp WAV is deleted on every path.
 */
export async function transcribeOffline(fileUri: string): Promise<{ text: string }> {
  if (getModelState().state !== 'ready') {
    await refreshModelState();
    if (getModelState().state !== 'ready') throw new ModelNotReadyError();
  }

  const wavPath = `${FileSystem.cacheDirectory}offline-${Date.now()}.wav`;
  const input = fileUri.replace(/^file:\/\//, '');
  try {
    const session = await FFmpegKit.execute(
      `-i "${input}" -ar 16000 -ac 1 -c:a pcm_s16le -y "${wavPath.replace(/^file:\/\//, '')}"`,
    );
    const code = await session.getReturnCode();
    if (!ReturnCode.isSuccess(code)) {
      throw new Error('Audio conversion for offline transcription failed');
    }

    const ctx = await getContext();
    const pref = await getSpokenLanguagePref();
    const { promise } = ctx.transcribe(wavPath, {
      // 'auto' keeps Whisper's own detection; an explicit pref avoids misdetection on short clips.
      language: pref === 'auto' ? undefined : pref,
      translate: false,
    });
    const result = await promise;
    return { text: (result.result || '').trim() };
  } finally {
    await FileSystem.deleteAsync(wavPath, { idempotent: true }).catch(() => {});
  }
}
