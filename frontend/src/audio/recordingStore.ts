/**
 * On-device recording storage and retention enforcement (plan.md M5).
 *
 * Recordings are copied out of expo-audio's cache into nueco/recordings/ at capture time
 * so they survive cache eviction and can back the note editor's player (M6). A JSON
 * manifest tracks every file with its capture metadata; sweeps delete whatever the
 * user's retention preference has expired. The manifest lives next to the files
 * (documentDirectory, file-backed like offlineSync's stores - never AsyncStorage, whose
 * row-size cap has bitten this codebase before).
 */
import * as FileSystem from 'expo-file-system/legacy';
import { File as FsFile } from 'expo-file-system';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Crypto from 'expo-crypto';
import {
  DEFAULT_RETENTION,
  findExpired,
  type AudioFileRecord,
  type RetentionPref,
  type WordTiming,
} from './retention';

const BASE_DIR = `${FileSystem.documentDirectory}nueco/`;
const RECORDINGS_DIR = `${BASE_DIR}recordings/`;
const MANIFEST_URI = `${BASE_DIR}recordings.json`;
export const RETENTION_PREF_KEY = 'audio_retention_pref';

let dirReady = false;
async function ensureDirs(): Promise<void> {
  if (dirReady) return;
  const info = await FileSystem.getInfoAsync(RECORDINGS_DIR);
  if (!info.exists) {
    await FileSystem.makeDirectoryAsync(RECORDINGS_DIR, { intermediates: true });
  }
  dirReady = true;
}

let manifestCache: AudioFileRecord[] | null = null;

async function readManifest(): Promise<AudioFileRecord[]> {
  if (manifestCache) return manifestCache;
  try {
    const info = await FileSystem.getInfoAsync(MANIFEST_URI);
    if (!info.exists) {
      manifestCache = [];
      return manifestCache;
    }
    const raw = await FileSystem.readAsStringAsync(MANIFEST_URI);
    const parsed = raw ? JSON.parse(raw) : [];
    manifestCache = Array.isArray(parsed) ? parsed : [];
    return manifestCache;
  } catch {
    manifestCache = [];
    return manifestCache;
  }
}

async function writeManifest(records: AudioFileRecord[]): Promise<void> {
  await ensureDirs();
  manifestCache = records;
  await FileSystem.writeAsStringAsync(MANIFEST_URI, JSON.stringify(records));
}

// Every manifest mutation is a read-modify-write over the shared cache. Callers fire several
// of these off in parallel (links, sweeps, transcript saves), and interleaved runs clobber each
// other's writes - silently dropping noteId links or whole records. Serialize them.
let manifestLock: Promise<unknown> = Promise.resolve();
function withManifestLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = manifestLock.then(fn, fn);
  manifestLock = run.catch(() => {});
  return run;
}

export async function listRecordings(): Promise<AudioFileRecord[]> {
  return readManifest();
}

/** Copy a freshly captured file into managed storage and register it. Returns the record. */
export async function saveRecording(
  sourceUri: string,
  opts: { noteId?: string; conversation?: boolean } = {},
): Promise<AudioFileRecord> {
  return withManifestLock(async () => {
    await ensureDirs();
    const id = Crypto.randomUUID();
    const ext = sourceUri.includes('.') ? sourceUri.slice(sourceUri.lastIndexOf('.')) : '.m4a';
    // Human-readable names (capture date + time) rather than UUIDs when users look at the
    // folder; the manifest id is the real key.
    const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
    const uri = `${RECORDINGS_DIR}capture-${stamp}${ext}`;
    await FileSystem.copyAsync({ from: sourceUri, to: uri });
    let sizeBytes: number | undefined;
    try {
      // The legacy API has no size option; the new API's File.size is a cheap metadata read.
      const size = new FsFile(uri).size;
      if (size > 0) sizeBytes = size;
    } catch {
      // size is cosmetic; don't fail the save over it
    }
    const record: AudioFileRecord = {
      id,
      uri,
      createdAt: Date.now(),
      sizeBytes,
      noteId: opts.noteId,
      conversation: opts.conversation,
    };
    const records = await readManifest();
    await writeManifest([...records, record]);
    return record;
  });
}

export async function markTranscribed(id: string): Promise<void> {
  return withManifestLock(async () => {
    const records = await readManifest();
    await writeManifest(records.map(r => (r.id === id ? { ...r, transcribedAt: Date.now() } : r)));
  });
}

export async function linkRecordingToNote(id: string, noteId: string): Promise<void> {
  return withManifestLock(async () => {
    const records = await readManifest();
    await writeManifest(records.map(r => (r.id === id ? { ...r, noteId } : r)));
  });
}

/** Persist the transcript's word timings, audio duration and full text onto a record so the note
 * editor player can seek by word, show total length, and export the words (plan.md M6). Words may
 * be undefined when the provider is text-only; transcriptText keeps the words regardless. */
export async function saveTranscript(
  id: string,
  words: WordTiming[] | undefined,
  durationSeconds: number | undefined,
  transcriptText: string,
): Promise<void> {
  return withManifestLock(async () => {
    const records = await readManifest();
    await writeManifest(records.map(r => (r.id === id ? { ...r, words, durationSeconds, transcriptText } : r)));
  });
}

/** All recordings linked to a note, oldest first. A note can accumulate several captures
 * (record, transcribe, record again), so reopening a note must surface every one of them. */
export async function getRecordingsForNote(noteId: string): Promise<AudioFileRecord[]> {
  const records = await readManifest();
  return records.filter(r => r.noteId === noteId).sort((a, b) => a.createdAt - b.createdAt);
}

/** Re-point recordings linked to a note's temporary local id once sync swaps it for the
 * server-assigned id - without this, reopening the note (now under its server id) finds no
 * recordings and the players look "lost". */
export async function migrateRecordingLinks(oldNoteId: string, newNoteId: string): Promise<void> {
  return withManifestLock(async () => {
    const records = await readManifest();
    if (!records.some(r => r.noteId === oldNoteId)) return;
    await writeManifest(records.map(r => (r.noteId === oldNoteId ? { ...r, noteId: newNoteId } : r)));
  });
}

export async function removeRecording(id: string): Promise<void> {
  return withManifestLock(async () => {
    const records = await readManifest();
    const target = records.find(r => r.id === id);
    if (target) {
      try {
        await FileSystem.deleteAsync(target.uri, { idempotent: true });
      } catch {
        // file already gone - still drop the manifest entry
      }
    }
    await writeManifest(records.filter(r => r.id !== id));
  });
}

export function getRetentionPref(): Promise<RetentionPref> {
  return AsyncStorage.getItem(RETENTION_PREF_KEY).then(v => {
    return v === 'immediate' || v === '30d' || v === 'indefinite' ? v : DEFAULT_RETENTION;
  }).catch(() => DEFAULT_RETENTION);
}

export function setRetentionPref(pref: RetentionPref): Promise<void> {
  return AsyncStorage.setItem(RETENTION_PREF_KEY, pref);
}

/** The language the user actually speaks into the mic. Auto-detect is the default (the OS
 * locale is not a reliable stand-in), but short or quiet clips make Whisper's per-clip
 * detection flip to the wrong language - an explicit choice overrides it deterministically. */
export type SpokenLanguagePref = 'auto' | 'en' | 'id';
export const SPOKEN_LANGUAGE_KEY = 'spoken_language_pref';
export const SPOKEN_LANGUAGE_OPTIONS: { value: SpokenLanguagePref; label: string; detail: string }[] = [
  { value: 'auto', label: 'Auto-detect', detail: 'Guess the language from each recording' },
  { value: 'en', label: 'English', detail: 'Always transcribe as English' },
  { value: 'id', label: 'Bahasa Indonesia', detail: 'Always transcribe as Bahasa Indonesia' },
];

export function getSpokenLanguagePref(): Promise<SpokenLanguagePref> {
  return AsyncStorage.getItem(SPOKEN_LANGUAGE_KEY)
    .then(v => (v === 'en' || v === 'id' ? v : 'auto'))
    .catch(() => 'auto');
}

export function setSpokenLanguagePref(pref: SpokenLanguagePref): Promise<void> {
  return AsyncStorage.setItem(SPOKEN_LANGUAGE_KEY, pref);
}

/** Conversation-mode audible announcement (plan/11): the genuinely protective option, since it
 * informs the other people in the room. Default off; the per-session consent prompt still asks
 * either way. */
const ANNOUNCEMENT_KEY = 'conversation_announcement_pref';

export function getAnnouncementPref(): Promise<boolean> {
  return AsyncStorage.getItem(ANNOUNCEMENT_KEY)
    .then(v => v === '1')
    .catch(() => false);
}

export function setAnnouncementPref(on: boolean): Promise<void> {
  return AsyncStorage.setItem(ANNOUNCEMENT_KEY, on ? '1' : '0');
}

/**
 * Delete every expired recording (file + manifest entry). Safe to run on every app start;
 * per-file failures don't stop the sweep. Returns how many were deleted.
 */
export async function sweepExpiredRecordings(nowMs: number = Date.now()): Promise<number> {
  return withManifestLock(async () => {
    const [records, pref] = await Promise.all([readManifest(), getRetentionPref()]);
    const expired = findExpired(records, pref, nowMs);
    if (expired.length === 0) return 0;
    for (const r of expired) {
      try {
        await FileSystem.deleteAsync(r.uri, { idempotent: true });
      } catch {
        // delete the manifest entry regardless: a file we can't see is not one we manage
      }
    }
    const expiredIds = new Set(expired.map(r => r.id));
    await writeManifest(records.filter(r => !expiredIds.has(r.id)));
    return expired.length;
  });
}

export async function removeAllRecordings(): Promise<number> {
  return withManifestLock(async () => {
    const records = await readManifest();
    for (const r of records) {
      try {
        await FileSystem.deleteAsync(r.uri, { idempotent: true });
      } catch {
        // best-effort
      }
    }
    await writeManifest([]);
    return records.length;
  });
}

export async function totalRecordingBytes(): Promise<number> {
  const records = await readManifest();
  return records.reduce((sum, r) => sum + (r.sizeBytes ?? 0), 0);
}
