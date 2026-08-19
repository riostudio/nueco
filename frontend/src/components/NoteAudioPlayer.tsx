import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, ActivityIndicator, Alert, TextInput,
} from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import * as LegacyFileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useAudioPlayer, useAudioPlayerStatus } from 'expo-audio';
import { C, radius } from '../theme';
import { formatClock, type AudioFileRecord, type WordTiming } from '../audio/retention';
import { removeRecording } from '../audio/recordingStore';
import { flagConversationRegions } from '../audio/conversation';

/**
 * Ephemeral speaker renames (plan/10 8b): in-memory only, applied across every conversation
 * player mounted in this app session, never persisted and never enrolled as a voiceprint. A
 * module-level map (not component state) is what makes a rename made on one recording apply
 * across the whole note when a note holds more than one capture.
 */
const speakerRenames = new Map<string, string>();

export function displaySpeaker(label: string): string {
  return speakerRenames.get(label) || label;
}

/** Word plus its position and any per-word flag derived from conversation analysis. */
interface DisplayWord {
  word: WordTiming;
  index: number;
  lowConfidence: boolean;
}

/** A contiguous piece of the conversation transcript for rendering. */
type TranscriptSegment =
  | { kind: 'overlap'; words: DisplayWord[]; startTime: number }
  | { kind: 'turn'; speaker: string; words: DisplayWord[] };

/**
 * Split diarized words into renderable segments (plan/10 8c): runs of overlapping/unattributed
 * words become marker blocks with no speaker attached; everything else groups into contiguous
 * speaker turns. Low-confidence words stay in their turn but render distinctly.
 */
function buildConversationSegments(words: WordTiming[]): TranscriptSegment[] {
  const flags = flagConversationRegions(words);
  const perWord: ('overlap' | 'low-confidence' | null)[] = words.map(() => null);
  for (const r of flags) {
    for (let i = r.startWord; i <= r.endWord && i < words.length; i++) {
      if (perWord[i] !== 'overlap') perWord[i] = r.reason;
    }
  }
  const segments: TranscriptSegment[] = [];
  for (let i = 0; i < words.length; i++) {
    const flag = perWord[i];
    const last = segments[segments.length - 1];
    if (flag === 'overlap') {
      if (last && last.kind === 'overlap') {
        last.words.push({ word: words[i], index: i, lowConfidence: false });
      } else {
        segments.push({ kind: 'overlap', startTime: words[i].start, words: [{ word: words[i], index: i, lowConfidence: false }] });
      }
      continue;
    }
    const speaker = words[i].speaker ?? 'Speaker';
    if (last && last.kind === 'turn' && last.speaker === speaker) {
      last.words.push({ word: words[i], index: i, lowConfidence: flag === 'low-confidence' });
    } else {
      segments.push({ kind: 'turn', speaker, words: [{ word: words[i], index: i, lowConfidence: flag === 'low-confidence' }] });
    }
  }
  return segments;
}

/**
 * First-class audio player for a note's source recording (plan.md M6 / REQ 1).
 *
 * Sits at the top of the note editor with the transcript grouped directly beneath it. The
 * recording is the recovery path for a transcript the user might otherwise trust too much, so
 * playback controls, a scrubber, speed control, tap-a-word-to-seek, and separate audio/text
 * export all live here in one unit.
 *
 * Waveform: real per-sample amplitudes would need a native decoder we don't have, so the bars are
 * derived from the word timings instead - time slices that contain a word render tall (speech),
 * gaps render short (silence). With a text-only provider (no timings) it falls back to a neutral
 * bar strip. Either way the played portion is tinted so progress is obvious.
 */
export function NoteAudioPlayer({
  recording,
  noteTitle,
  transcriptText,
  onRemove,
}: {
  recording: AudioFileRecord;
  noteTitle?: string;
  /** The full transcript string; used for the separate text export and as a fallback label. */
  transcriptText?: string;
  /** Called after the underlying file is removed or found missing, so the parent can unmount. */
  onRemove?: () => void;
}) {
  const player = useAudioPlayer(recording.uri);
  const status = useAudioPlayerStatus(player);

  const [missing, setMissing] = useState(false);
  const [checkingFile, setCheckingFile] = useState(true);
  const [speed, setSpeed] = useState<1 | 1.5 | 2>(1);
  const [removing, setRemoving] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [stripWidth, setStripWidth] = useState(0);

  const words: WordTiming[] = useMemo(() => recording.words ?? [], [recording.words]);
  // Conversation captures render speaker turns + flagged regions instead of the flat word strip
  // (plan/10 8b/8c). Requires diarized words; a conversation record without speaker data falls
  // back to the flat transcript rather than inventing attribution.
  const isConversation = Boolean(recording.conversation) && words.some(w => w.speaker);
  const segments = useMemo(
    () => (isConversation ? buildConversationSegments(words) : []),
    [isConversation, words],
  );
  // Bumped after each rename commit so the module-level rename map re-renders everywhere.
  const [renameVersion, setRenameVersion] = useState(0);
  const [renamingSpeaker, setRenamingSpeaker] = useState<string | null>(null);
  // One speaker owns many turns; only the tapped chip becomes the editor.
  const [renamingIndex, setRenamingIndex] = useState<number | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  // Set on press-in of the cancel button so the blur that precedes the press doesn't commit.
  const cancelNextBlur = useRef(false);
  // Prefer the player's live duration once known; fall back to the stored value, then the last
  // word's end time, so the scrubber and total label have something real before load completes.
  const duration = (status && status.duration > 0 ? status.duration : 0)
    || recording.durationSeconds
    || (words.length ? words[words.length - 1].end : 0);
  const currentTime = status?.currentTime ?? 0;
  const playing = status?.playing ?? false;

  // Verify the file still exists - retention sweeps delete expired captures, and a linked note
  // whose audio has rolled off shows a plain "expired" line instead of a dead player (M6 expiry).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const info = await LegacyFileSystem.getInfoAsync(recording.uri);
        if (!cancelled) setMissing(!info.exists);
      } catch {
        if (!cancelled) setMissing(true);
      } finally {
        if (!cancelled) setCheckingFile(false);
      }
    })();
    return () => { cancelled = true; };
  }, [recording.uri]);

  // Keep playback alive across scrolls/edits: the player is independent of the transcript view,
  // so nothing here stops it when the user interacts with the words below.

  const togglePlay = useCallback(() => {
    try {
      if (playing) player.pause();
      else player.play();
    } catch {
      // A transient native error shouldn't crash the editor; the UI stays consistent.
    }
  }, [player, playing]);

  const seekTo = useCallback((seconds: number) => {
    const clamped = Math.max(0, Math.min(duration || 0, seconds));
    player.seekTo(clamped).catch(() => {});
  }, [player, duration]);

  // Tapping a flagged region plays that audio segment - the recording is the ground truth, and
  // the marker exists precisely because the transcript there must not be trusted (plan/10 8c).
  const playSegment = useCallback((startTime: number) => {
    seekTo(startTime);
    try {
      player.play();
    } catch {
      // Transient native error; the scrubber still works.
    }
  }, [player, seekTo]);

  const startRename = useCallback((speaker: string, segmentIndex: number) => {
    setRenamingSpeaker(speaker);
    setRenamingIndex(segmentIndex);
    setRenameDraft(displaySpeaker(speaker));
  }, []);

  const commitRename = useCallback(() => {
    if (renamingSpeaker != null) {
      const next = renameDraft.trim();
      if (next) speakerRenames.set(renamingSpeaker, next);
      else speakerRenames.delete(renamingSpeaker);
      setRenameVersion(v => v + 1);
    }
    setRenamingSpeaker(null);
    setRenamingIndex(null);
  }, [renamingSpeaker, renameDraft]);

  const cancelRename = useCallback(() => {
    setRenamingSpeaker(null);
    setRenamingIndex(null);
  }, []);

  const handleRenameBlur = useCallback(() => {
    if (cancelNextBlur.current) {
      cancelNextBlur.current = false;
      return;
    }
    commitRename();
  }, [commitRename]);

  const cycleSpeed = useCallback(() => {
    const next = speed === 1 ? 1.5 : speed === 1.5 ? 2 : 1;
    setSpeed(next as 1 | 1.5 | 2);
    try {
      player.shouldCorrectPitch = true;
      player.setPlaybackRate(next);
    } catch {
      // Speed is a nicety; playback continues at the previous rate.
    }
  }, [player, speed]);

  // Tap anywhere on the waveform strip to seek to that fraction of the duration.
  const handleStripSeek = useCallback((locationX: number) => {
    if (!stripWidth || !duration) return;
    const fraction = Math.max(0, Math.min(1, locationX / stripWidth));
    seekTo(fraction * duration);
  }, [stripWidth, duration, seekTo]);

  // Filename for exports: note title + capture date, never the raw UUID (plan.md M6).
  const exportBaseName = useMemo(() => {
    const title = (noteTitle || 'Note').trim().replace(/[\\/:*?"<>|\r\n]/g, ' ').replace(/\s+/g, ' ').trim() || 'Note';
    const d = new Date(recording.createdAt);
    const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    return `${title.slice(0, 60)} ${date}`;
  }, [noteTitle, recording.createdAt]);

  // Sharing a recording of other people is the higher-risk act (plan.md 8.3): the first time a
  // conversation-mode capture is exported, confirm deliberately. One-time, awareness not nagging.
  const shareAudioFile = useCallback(async () => {
    const ext = recording.uri.includes('.') ? recording.uri.slice(recording.uri.lastIndexOf('.')) : '.m4a';
    const dest = `${LegacyFileSystem.cacheDirectory}${exportBaseName.replace(/\s+/g, '_')}${ext}`;
    await LegacyFileSystem.copyAsync({ from: recording.uri, to: dest });
    await Sharing.shareAsync(dest, {
      mimeType: ext === '.wav' ? 'audio/wav' : 'audio/mp4',
      dialogTitle: 'Share recording',
    });
  }, [recording.uri, exportBaseName]);

  const exportAudio = useCallback(async () => {
    if (exporting) return;
    if (recording.conversation) {
      const WARNED_KEY = 'conversation_audio_share_warned';
      const alreadyWarned = await AsyncStorage.getItem(WARNED_KEY).catch(() => '1');
      if (alreadyWarned !== '1') {
        Alert.alert(
          'This recording includes other people',
          'Sharing audio of a conversation means sharing other people\'s voices, not just your notes. The transcript can be shared separately without the audio.',
          [
            { text: 'Cancel', style: 'cancel' },
            {
              text: 'Share audio anyway',
              style: 'destructive',
              onPress: () => {
                AsyncStorage.setItem(WARNED_KEY, '1').catch(() => {});
                setExporting(true);
                shareAudioFile()
                  .catch(e => console.warn('Audio export failed:', e))
                  .finally(() => setExporting(false));
              },
            },
          ],
        );
        return;
      }
    }
    setExporting(true);
    try {
      await shareAudioFile();
    } catch (e) {
      console.warn('Audio export failed:', e);
    } finally {
      setExporting(false);
    }
  }, [exporting, recording.conversation, recording.uri, exportBaseName, shareAudioFile]);

  const exportTranscript = useCallback(async () => {
    if (exporting) return;
    const text = transcriptText ?? words.map(w => w.word).join(' ');
    if (!text.trim()) return;
    setExporting(true);
    try {
      const dest = `${LegacyFileSystem.cacheDirectory}${exportBaseName.replace(/\s+/g, '_')}_transcript.txt`;
      await LegacyFileSystem.writeAsStringAsync(dest, text);
      // Share the file itself, not a text message: RN's Share only sends the message string on
      // Android, so apps like WhatsApp received text with no attachment.
      await Sharing.shareAsync(dest, { mimeType: 'text/plain', dialogTitle: 'Share transcript' });
    } catch (e) {
      console.warn('Transcript export failed:', e);
    } finally {
      setExporting(false);
    }
  }, [exporting, transcriptText, words, exportBaseName]);

  const handleDeleteRecording = useCallback(async () => {
    if (removing) return;
    setRemoving(true);
    try {
      await removeRecording(recording.id);
      onRemove?.();
    } catch (e) {
      console.warn('Could not remove recording:', e);
      setRemoving(false);
    }
  }, [removing, recording.id, onRemove]);

  if (checkingFile) {
    return (
      <View style={s.card}>
        <ActivityIndicator size="small" color={C.textSec} />
      </View>
    );
  }

  if (missing) {
    return (
      <View style={s.card}>
        <MaterialIcons name="mic-off" size={20} color={C.textSec} />
        <Text style={s.expiredText}>
          The audio for this note has expired and was removed from this device. The transcript
          below is unchanged. To keep recordings longer, change the retention setting under
          Settings → Voice recordings.
        </Text>
      </View>
    );
  }

  const progress = duration > 0 ? currentTime / duration : 0;

  return (
    <View style={s.card}>
      <View style={s.topRow}>
        <TouchableOpacity
          testID="note-audio-play-btn"
          style={s.playBtn}
          onPress={togglePlay}
          accessibilityLabel={playing ? 'Pause recording' : 'Play recording'}
        >
          <MaterialIcons name={playing ? 'pause' : 'play-arrow'} size={30} color={C.primaryFg} />
        </TouchableOpacity>

        <View style={{ flex: 1, marginHorizontal: 12 }}>
          {/* Waveform / scrubber */}
          <TouchableOpacity
            activeOpacity={0.9}
            onPressIn={e => handleStripSeek(e.nativeEvent.locationX)}
            onLayout={e => setStripWidth(e.nativeEvent.layout.width)}
          >
            <View style={s.waveStrip} pointerEvents="none">
              {buildBars(words, duration).map((h, i, arr) => {
                const frac = arr.length > 1 ? i / (arr.length - 1) : 0;
                const played = frac <= progress;
                return (
                  <View
                    key={i}
                    style={[
                      s.waveBar,
                      { height: h, backgroundColor: played ? C.primary : C.borderSub + '55' },
                    ]}
                  />
                );
              })}
            </View>
          </TouchableOpacity>
          <View style={s.timeRow}>
            <Text style={s.timeText}>{formatClock(currentTime)}</Text>
            <Text style={s.timeText}>{formatClock(duration)}</Text>
          </View>
        </View>

        <TouchableOpacity testID="note-audio-speed-btn" style={s.speedBtn} onPress={cycleSpeed}>
          <Text style={s.speedText}>{speed}x</Text>
        </TouchableOpacity>
      </View>

      {isConversation ? (
        <View style={s.conversationWrap} key={renameVersion}>
          {segments.map((seg, si) => {
            if (seg.kind === 'overlap') {
              return (
                <TouchableOpacity
                  key={si}
                  style={s.overlapBlock}
                  onPress={() => playSegment(seg.startTime)}
                  accessibilityLabel="Two people speaking. Tap to listen."
                >
                  <View style={s.overlapHeader}>
                    <MaterialIcons name="graphic-eq" size={16} color={C.warning} />
                    <Text style={s.overlapTitle}>Two people speaking</Text>
                    <Text style={s.overlapHint}>Tap to listen</Text>
                  </View>
                  {/* Words shown WITHOUT a speaker label - attribution here would be a guess
                      (plan/10 8c: mark, do not fabricate). */}
                  <Text style={s.overlapWords}>
                    {seg.words.map(dw => dw.word.word).join(' ')}
                  </Text>
                </TouchableOpacity>
              );
            }
            const label = displaySpeaker(seg.speaker);
            return (
              <View key={si} style={s.turnBlock}>
                {renamingSpeaker === seg.speaker && renamingIndex === si ? (
                  <View style={s.renameRow}>
                    <TextInput
                      style={s.renameInput}
                      value={renameDraft}
                      onChangeText={setRenameDraft}
                      onBlur={handleRenameBlur}
                      onSubmitEditing={commitRename}
                      autoFocus
                      selectTextOnFocus
                      returnKeyType="done"
                    />
                    <TouchableOpacity
                      style={s.renameIconBtn}
                      onPress={commitRename}
                      accessibilityLabel="Save name"
                    >
                      <MaterialIcons name="check" size={18} color={C.primary} />
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={s.renameIconBtn}
                      onPressIn={() => { cancelNextBlur.current = true; }}
                      onPress={cancelRename}
                      accessibilityLabel="Cancel rename"
                    >
                      <MaterialIcons name="close" size={18} color={C.textSec} />
                    </TouchableOpacity>
                  </View>
                ) : (
                  <TouchableOpacity
                    style={s.speakerChipWrap}
                    onPress={() => startRename(seg.speaker, si)}
                    accessibilityLabel={`Rename ${label}`}
                  >
                    <Text style={s.speakerChip}>{label}</Text>
                    <MaterialIcons name="edit" size={12} color={C.secondary} />
                  </TouchableOpacity>
                )}
                <Text style={s.turnText}>
                  {seg.words.map(dw => (
                    <Text
                      key={dw.index}
                      style={dw.lowConfidence ? s.lowConfWord : undefined}
                      onPress={() => seekTo(dw.word.start)}
                    >
                      {dw.word.word}{' '}
                    </Text>
                  ))}
                </Text>
              </View>
            );
          })}
        </View>
      ) : words.length > 0 ? (
        <View style={s.transcriptWrap}>
          {words.map((w, i) => {
            const active = currentTime >= w.start && currentTime < w.end;
            return (
              <TouchableOpacity key={i} onPress={() => seekTo(w.start)} style={s.wordChipWrap}>
                <Text style={[s.wordChip, active && s.wordChipActive]}>{w.word}</Text>
              </TouchableOpacity>
            );
          })}
        </View>
      ) : null}

      <View style={s.actionRow}>
        <TouchableOpacity style={s.actionBtn} onPress={exportAudio} disabled={exporting}>
          <MaterialIcons name="ios-share" size={18} color={C.secondary} />
          <Text style={s.actionText}>Audio</Text>
        </TouchableOpacity>
        <TouchableOpacity style={s.actionBtn} onPress={exportTranscript} disabled={exporting}>
          <MaterialIcons name="description" size={18} color={C.secondary} />
          <Text style={s.actionText}>Transcript</Text>
        </TouchableOpacity>
        <View style={{ flex: 1 }} />
        <TouchableOpacity
          style={s.actionBtn}
          onPress={handleDeleteRecording}
          disabled={removing}
          accessibilityLabel="Delete recording"
        >
          {removing
            ? <ActivityIndicator size="small" color={C.danger} />
            : <MaterialIcons name="delete-outline" size={18} color={C.danger} />}
        </TouchableOpacity>
      </View>
    </View>
  );
}

/** Build a fixed bar count from word timings: slices overlapping a word render tall (speech),
 * gaps render short (silence). No timings -> a uniform neutral strip. */
function buildBars(words: WordTiming[], duration: number): number[] {
  const BAR_COUNT = 42;
  const bars: number[] = [];
  if (!duration || duration <= 0) {
    for (let i = 0; i < BAR_COUNT; i++) bars.push(12);
    return bars;
  }
  if (!words.length) {
    // Deterministic pseudo-waveform so a text-only transcript still reads as audio, not noise.
    for (let i = 0; i < BAR_COUNT; i++) {
      const t = Math.sin(i * 1.7) * 0.5 + 0.5;
      bars.push(8 + Math.round(t * 18));
    }
    return bars;
  }
  for (let i = 0; i < BAR_COUNT; i++) {
    const sliceStart = (i / BAR_COUNT) * duration;
    const sliceEnd = ((i + 1) / BAR_COUNT) * duration;
    const hasSpeech = words.some(w => w.start < sliceEnd && w.end > sliceStart);
    bars.push(hasSpeech ? 22 : 8);
  }
  return bars;
}

const s = StyleSheet.create({
  card: {
    backgroundColor: C.surface,
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: radius.lg,
    padding: 14,
    marginBottom: 12,
  },
  topRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  playBtn: {
    width: 46,
    height: 46,
    borderRadius: 23,
    backgroundColor: C.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  waveStrip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    height: 26,
  },
  waveBar: {
    flex: 1,
    borderRadius: 1,
    minWidth: 1,
  },
  timeRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 4,
  },
  timeText: {
    fontSize: 12,
    color: C.textSec,
  },
  speedBtn: {
    minWidth: 46,
    height: 32,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: C.secondary,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 8,
  },
  speedText: {
    fontSize: 14,
    fontWeight: '600',
    color: C.secondary,
  },
  transcriptWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginTop: 12,
    gap: 2,
  },
  wordChipWrap: {
    paddingVertical: 1,
  },
  wordChip: {
    fontSize: 15,
    lineHeight: 22,
    color: C.text,
    paddingHorizontal: 2,
    borderRadius: 4,
  },
  wordChipActive: {
    backgroundColor: C.secondaryTint,
    color: C.secondary,
    fontWeight: '600',
  },
  conversationWrap: {
    marginTop: 12,
    gap: 10,
  },
  turnBlock: {
    gap: 4,
  },
  speakerChipWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    alignSelf: 'flex-start',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: radius.pill,
    backgroundColor: C.secondaryTint,
  },
  speakerChip: {
    fontSize: 13,
    fontWeight: '600',
    color: C.secondary,
  },
  renameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: 6,
    maxWidth: '100%',
  },
  renameInput: {
    flexShrink: 1,
    minWidth: 110,
    maxWidth: 220,
    fontSize: 13,
    fontWeight: '600',
    color: C.secondary,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: radius.pill,
    backgroundColor: C.secondaryTint,
    borderWidth: 1,
    borderColor: C.secondary,
  },
  renameIconBtn: {
    width: 30,
    height: 30,
    borderRadius: 15,
    borderWidth: 1,
    borderColor: C.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  turnText: {
    fontSize: 15,
    lineHeight: 22,
    color: C.text,
  },
  lowConfWord: {
    color: C.textSec,
    fontStyle: 'italic',
  },
  overlapBlock: {
    borderWidth: 1,
    borderColor: C.warning + '66',
    backgroundColor: C.warning + '14',
    borderRadius: radius.md,
    padding: 10,
    gap: 4,
  },
  overlapHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  overlapTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: C.text,
  },
  overlapHint: {
    fontSize: 12,
    color: C.textSec,
    marginLeft: 'auto',
  },
  overlapWords: {
    fontSize: 14,
    lineHeight: 20,
    color: C.textSec,
    fontStyle: 'italic',
  },
  actionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 12,
    gap: 8,
  },
  actionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: C.border,
    minHeight: 32,
    minWidth: 32,
    justifyContent: 'center',
  },
  actionText: {
    fontSize: 14,
    color: C.secondary,
    fontWeight: '500',
  },
  expiredText: {
    flex: 1,
    marginLeft: 10,
    fontSize: 13,
    lineHeight: 19,
    color: C.textSec,
  },
});
