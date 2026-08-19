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
 * Model ladder (all quantized multilingual ggml builds, covering the app's en + id
 * spoken-language preference):
 *  - tier 1: ggml-tiny-q5_1 (~31 MB) - downloaded first so offline capture works quickly;
 *  - tier 2: ggml-base-q5_1 (~57 MB) - background upgrade once tiny is ready, hot-swapped
 *    in when the current transcription context is released.
 * Downloads run in 8 MB chunks via HTTP Range, each cached as its own part file, so a flaky
 * connection (or the app being closed) never loses more than one chunk. Completed chunks
 * are skipped on resume. A legacy ggml-small-q5_1 install is kept as the best model.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system/legacy';
import { File as ModelFile } from 'expo-file-system';
import { FFmpegKit, ReturnCode } from 'ffmpeg-kit-react-native';
import { initWhisper, type WhisperContext } from 'whisper.rn/index';
import { isNetworkAvailable } from '../offlineSync';
import { getSpokenLanguagePref } from './recordingStore';

export const OFFLINE_TRANSCRIPTION_ENABLED_KEY = 'offline_transcription_enabled';

export type ModelTier = 'tiny' | 'base' | 'small';

interface TierSpec {
  tier: ModelTier;
  filename: string;
  url: string;
  bytes: number;
}

// Sizes verified against huggingface.co/ggerganov/whisper.cpp (tree API) 2026-08-19.
const TIERS: Record<ModelTier, TierSpec> = {
  small: {
    tier: 'small',
    filename: 'ggml-small-q5_1.bin',
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small-q5_1.bin',
    bytes: 190085487,
  },
  base: {
    tier: 'base',
    filename: 'ggml-base-q5_1.bin',
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base-q5_1.bin',
    bytes: 59707625,
  },
  tiny: {
    tier: 'tiny',
    filename: 'ggml-tiny-q5_1.bin',
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny-q5_1.bin',
    bytes: 32152673,
  },
};

const MB = 1024 * 1024;
export const TINY_MODEL_MB = Math.round(TIERS.tiny.bytes / MB);   // 31
export const BASE_MODEL_MB = Math.round(TIERS.base.bytes / MB);   // 57
export const SMALL_MODEL_MB = Math.round(TIERS.small.bytes / MB); // 181

const CHUNK_BYTES = 8 * MB;

const MODELS_DIR = `${FileSystem.documentDirectory}nueco/models/`;
const PARTS_DIR = `${MODELS_DIR}parts/`;
const CHUNK_STATE_KEY = 'offline_model_chunk_state_v2';
// Legacy single-stream resumable state from the old one-file download; no longer readable
// by the chunked downloader, cleaned up on first refresh.
const LEGACY_DOWNLOAD_STATE_KEY = 'offline_model_download_state';

export type ModelState =
  | 'not_downloaded'
  | 'downloading'
  | 'ready'
  | 'upgrading'
  | 'error';

export interface ModelStateInfo {
  state: ModelState;
  /** 0..1 progress of the active download/upgrade */
  progress: number;
  error: string | null;
  /** Which model is usable right now (best on disk), if any. */
  tier: ModelTier | null;
}

export class ModelNotReadyError extends Error {
  constructor() {
    super('Offline transcription model is not downloaded');
    this.name = 'ModelNotReadyError';
  }
}

// ---- state machine ---------------------------------------------------------------------------

let current: ModelStateInfo = { state: 'not_downloaded', progress: 0, error: null, tier: null };
let initialized = false;
// True between chunk-loop iterations; pause/turn-off sets it so the job stops at the next
// chunk boundary. The in-flight chunk (<= 8 MB) is allowed to finish, so pausing never
// tears a part file.
let cancelRequested = false;

function setModelState(patch: Partial<ModelStateInfo>) {
  current = { ...current, ...patch };
  for (const cb of listeners) cb(current);
}

const listeners = new Set<(info: ModelStateInfo) => void>();

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

function modelPath(spec: TierSpec): string {
  return `${MODELS_DIR}${spec.filename}`;
}

async function fileBytes(path: string): Promise<number | null> {
  try {
    const info = await FileSystem.getInfoAsync(path);
    return info.exists ? info.size : null;
  } catch {
    return null;
  }
}

/** Best verified model on disk, or null. */
async function detectTier(): Promise<ModelTier | null> {
  for (const tier of ['small', 'base', 'tiny'] as ModelTier[]) {
    const spec = TIERS[tier];
    if ((await fileBytes(modelPath(spec))) === spec.bytes) return tier;
  }
  return null;
}

/** Derive initial state from disk. Called from Settings, the router, and app start. */
export async function refreshModelState(): Promise<void> {
  if (initialized) return;
  initialized = true;

  // Torn final files are useless; drop them so the ladder starts clean.
  for (const tier of ['small', 'base', 'tiny'] as ModelTier[]) {
    const spec = TIERS[tier];
    const size = await fileBytes(modelPath(spec));
    if (size !== null && size !== spec.bytes) {
      await FileSystem.deleteAsync(modelPath(spec), { idempotent: true }).catch(() => {});
    }
  }
  await AsyncStorage.removeItem(LEGACY_DOWNLOAD_STATE_KEY).catch(() => {});

  const tier = await detectTier();
  if (tier === 'base' || tier === 'small') {
    setModelState({ state: 'ready', progress: 1, error: null, tier });
    return;
  }
  if (tier === 'tiny') {
    setModelState({ state: 'ready', progress: 1, error: null, tier });
    // Opted-in users get the quality upgrade trickling down in the background.
    if ((await isOfflineTranscriptionEnabled()) && (await isNetworkAvailable())) {
      void startModelDownload();
    }
    return;
  }
  setModelState({ state: 'not_downloaded', progress: 0, error: null, tier: null });
  // Auto-resume an interrupted tiny download: the user opted in via the toggle, and
  // completed chunks are already on disk.
  if ((await isOfflineTranscriptionEnabled()) && (await isNetworkAvailable())) {
    void startModelDownload();
  }
}

// ---- chunked download ------------------------------------------------------------------------

interface ChunkState {
  filename: string;
  totalBytes: number;
  done: number[];
}

async function readChunkState(): Promise<ChunkState | null> {
  try {
    const raw = await AsyncStorage.getItem(CHUNK_STATE_KEY);
    return raw ? (JSON.parse(raw) as ChunkState) : null;
  } catch {
    return null;
  }
}

async function writeChunkState(state: ChunkState | null) {
  if (state) await AsyncStorage.setItem(CHUNK_STATE_KEY, JSON.stringify(state));
  else await AsyncStorage.removeItem(CHUNK_STATE_KEY);
}

function chunkSpec(spec: TierSpec, index: number): { start: number; end: number; size: number } {
  const start = index * CHUNK_BYTES;
  const end = Math.min(start + CHUNK_BYTES, spec.bytes) - 1;
  return { start, end, size: end - start + 1 };
}

function chunkCount(spec: TierSpec): number {
  return Math.ceil(spec.bytes / CHUNK_BYTES);
}

function partPath(spec: TierSpec, index: number): string {
  return `${PARTS_DIR}${spec.filename}.part-${index}`;
}

/**
 * Download one tier as 8 MB Range chunks into part files, then assemble the final model.
 * Resolves true when the model is complete, false when cancelled between chunks. Throws if
 * the server ignores Range requests or a chunk download fails.
 */
async function downloadChunked(
  spec: TierSpec,
  reportProgress: (fraction: number) => void,
): Promise<boolean> {
  await FileSystem.makeDirectoryAsync(PARTS_DIR, { intermediates: true }).catch(() => {});

  let chunkState = await readChunkState();
  if (!chunkState || chunkState.filename !== spec.filename || chunkState.totalBytes !== spec.bytes) {
    chunkState = { filename: spec.filename, totalBytes: spec.bytes, done: [] };
  }
  const done = new Set(chunkState.done);
  let doneBytes = [...done].reduce((sum, i) => sum + chunkSpec(spec, i).size, 0);
  reportProgress(doneBytes / spec.bytes);

  const total = chunkCount(spec);
  for (let i = 0; i < total; i++) {
    if (cancelRequested) return false;

    const { start, end, size } = chunkSpec(spec, i);
    const part = partPath(spec, i);

    // Already cached from an earlier attempt - verify, then skip.
    if (done.has(i) && (await fileBytes(part)) === size) {
      continue;
    }

    await FileSystem.downloadAsync(spec.url, part, {
      headers: { Range: `bytes=${start}-${end}` },
    });
    if ((await fileBytes(part)) !== size) {
      // Range was not honoured (or the transfer tore) - refuse to assemble garbage.
      await FileSystem.deleteAsync(part, { idempotent: true }).catch(() => {});
      throw new Error('Model server did not serve the requested chunk');
    }

    done.add(i);
    doneBytes += size;
    await writeChunkState({ ...chunkState, done: [...done] });
    reportProgress(doneBytes / spec.bytes);
  }

  // Assemble: append each part in order. The legacy API has no positional write, so this
  // uses the new expo-file-system File API's append mode.
  const finalFile = new ModelFile(modelPath(spec));
  for (let i = 0; i < total; i++) {
    const b64 = await FileSystem.readAsStringAsync(partPath(spec, i), { encoding: 'base64' });
    finalFile.write(b64, { encoding: 'base64', append: i > 0 });
  }

  const finalPath = modelPath(spec);
  if ((await fileBytes(finalPath)) !== spec.bytes) {
    await FileSystem.deleteAsync(finalPath, { idempotent: true }).catch(() => {});
    throw new Error('Model assembly produced the wrong size');
  }

  // Success - clear the cache.
  for (let i = 0; i < total; i++) {
    await FileSystem.deleteAsync(partPath(spec, i), { idempotent: true }).catch(() => {});
  }
  await writeChunkState(null);
  return true;
}

let downloadRunning = false;

/**
 * Drive the ladder: fetch whatever is missing. Nothing on disk -> tiny (the fast one);
 * tiny on disk -> the base upgrade in the background. Idempotent; safe to call repeatedly.
 */
export async function startModelDownload(): Promise<void> {
  if (downloadRunning) return;
  cancelRequested = false;

  const tier = await detectTier();
  const target = tier === 'tiny' ? TIERS.base : tier === null ? TIERS.tiny : null;
  if (!target) return; // base or small already present: nothing to fetch

  downloadRunning = true;
  const isUpgrade = tier === 'tiny';
  setModelState(
    isUpgrade
      ? { state: 'upgrading', progress: 0, error: null }
      : { state: 'downloading', progress: 0, error: null },
  );

  try {
    const finished = await downloadChunked(target, fraction => setModelState({ progress: fraction }));
    if (!finished) {
      // Cancelled between chunks - cached chunks stay on disk for the next attempt.
      setModelState(isUpgrade ? { state: 'ready', progress: 1 } : { state: 'not_downloaded', progress: 0 });
      return;
    }
    if (isUpgrade) {
      setModelState({ state: 'ready', progress: 1, error: null, tier: 'base' });
      // Drop the tiny context so the next transcription loads base.
      if (loadedModelPath && loadedModelPath !== modelPath(TIERS.base)) {
        await releaseWhisperContext();
      }
    } else {
      setModelState({ state: 'ready', progress: 1, error: null, tier: 'tiny' });
      // Straight into the quality upgrade while the user is opted in.
      if ((await isOfflineTranscriptionEnabled()) && (await isNetworkAvailable())) {
        downloadRunning = false;
        void startModelDownload();
        return;
      }
    }
  } catch (e) {
    if (isUpgrade) {
      // The upgrade is a bonus - tiny still works, so don't surface an error state.
      setModelState({ state: 'ready', progress: 1, error: null, tier: 'tiny' });
    } else {
      setModelState({ state: 'error', error: (e as Error)?.message || 'Download failed' });
    }
  } finally {
    downloadRunning = false;
  }
}

/** Stop the active download/upgrade at the next chunk boundary. Cached chunks are kept. */
export async function pauseModelDownload(): Promise<void> {
  cancelRequested = true;
  if (!downloadRunning) {
    setModelState(current.tier ? { state: 'ready', progress: 1 } : { state: 'not_downloaded', progress: 0 });
  }
}

export async function deleteModel(): Promise<void> {
  cancelRequested = true;
  await releaseWhisperContext();
  for (const tier of ['small', 'base', 'tiny'] as ModelTier[]) {
    await FileSystem.deleteAsync(modelPath(TIERS[tier]), { idempotent: true }).catch(() => {});
  }
  await FileSystem.deleteAsync(PARTS_DIR, { idempotent: true }).catch(() => {});
  await writeChunkState(null);
  await AsyncStorage.removeItem(LEGACY_DOWNLOAD_STATE_KEY).catch(() => {});
  // Wait a beat for an in-flight chunk loop to notice the cancel before flipping state.
  setModelState({ state: 'not_downloaded', progress: 0, error: null, tier: null });
}

// ---- transcription -----------------------------------------------------------------------------

let whisperContext: WhisperContext | null = null;
let loadedModelPath: string | null = null;

async function getContext(): Promise<WhisperContext> {
  if (whisperContext) return whisperContext;
  const tier = await detectTier();
  if (!tier) throw new ModelNotReadyError();
  const path = modelPath(TIERS[tier]);
  // whisper.rn wants a plain filesystem path, not a file:// URI.
  whisperContext = await initWhisper({ filePath: path.replace(/^file:\/\//, '') });
  loadedModelPath = path;
  return whisperContext;
}

export async function releaseWhisperContext(): Promise<void> {
  if (whisperContext) {
    await whisperContext.release().catch(() => {});
    whisperContext = null;
    loadedModelPath = null;
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
  const s = getModelState().state;
  if (s !== 'ready' && s !== 'upgrading') {
    await refreshModelState();
    const after = getModelState().state;
    if (after !== 'ready' && after !== 'upgrading') throw new ModelNotReadyError();
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
