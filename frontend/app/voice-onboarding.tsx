/**
 * First-run voice onboarding: gets a brand-new user to capture their first note by SPEAKING.
 *
 * Three full-screen states in one file (ask → listening → review), matching the agreed concept
 * screens. Earlier this handed off to the note editor and reused its bottom-bar recorder and
 * "Transcription Complete!" dialog; that shared one code path but looked nothing like the design,
 * and the editor's chrome is a lot of surface for someone who has not yet made a single note.
 *
 * It still shares the machinery that matters - the same expo-audio recorder, the same
 * transcribeApi, the same RecordingWaveform - so silence handling and transcription behaviour stay
 * identical to the main editor. Only the presentation is bespoke.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator, Alert, ScrollView, Animated, Easing } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { MaterialIcons } from '@expo/vector-icons';
import { useRouter, type Href } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { useAudioRecorder, AudioModule, RecordingPresets, setAudioModeAsync } from 'expo-audio';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useAuth } from '../src/auth/context/AuthContext';
import { transcribeApi, textProcessApi } from '../src/api';
import { createNoteOffline } from '../src/offlineSync';
import { trackOnboardingStep, trackNoteCreated, trackVoiceRecordingStarted, trackVoiceRecordingCompleted, trackVoiceTranscriptionInserted } from '../src/analytics';
import { RecordingWaveform } from '../src/components/RecordingWaveform';
import { C } from '../src/theme';

export const VOICE_ONBOARDING_SEEN_PREFIX = 'voice_onboarding_seen';

// Same escaping the editor uses when it turns dictated text into paragraphs (editor.tsx's own
// local helper) - kept in step so a note captured here is byte-identical to one captured there.
function escapeHtml(t: string): string {
  return t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

type Stage = 'ask' | 'listening' | 'transcribing' | 'review';
type Tidy = 'keep' | 'organise';

/** Splits a transcript into a short title and the remaining body, the way the concept card shows
 *  it. A single short sentence becomes the body with no title rather than an awkward stub. */
function splitTitleAndBody(text: string): { title: string; body: string } {
  const clean = text.trim();
  const firstBreak = clean.search(/[.!?]\s/);
  if (firstBreak > 0 && firstBreak < 60 && clean.length > firstBreak + 2) {
    return { title: clean.slice(0, firstBreak).trim(), body: clean.slice(firstBreak + 1).trim() };
  }
  return { title: '', body: clean };
}

export default function VoiceOnboardingScreen() {
  const router = useRouter();
  const { user } = useAuth();

  const [stage, setStage] = useState<Stage>('ask');
  const [transcript, setTranscript] = useState('');
  const [tidy, setTidy] = useState<Tidy>('keep');
  const [saving, setSaving] = useState(false);
  const startedAt = useRef<number | null>(null);

  // Slow breathing halo behind the mic: expands and fades out, pauses, repeats. Signals "ready to
  // listen" without the urgency of a fast pulse, and is the only motion on an otherwise still
  // screen. Native-driven so it can't compete with the recorder for the JS thread.
  const halo = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (stage !== 'ask') return;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(halo, { toValue: 1, duration: 2600, easing: Easing.out(Easing.quad), useNativeDriver: true }),
        Animated.timing(halo, { toValue: 0, duration: 0, useNativeDriver: true }),
        Animated.delay(700),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [stage, halo]);

  const recorder = useAudioRecorder({ ...RecordingPresets.HIGH_QUALITY, isMeteringEnabled: true });
  const getMetering = useCallback(() => {
    try { return recorder.getStatus?.()?.metering; } catch { return undefined; }
  }, [recorder]);

  const markSeen = useCallback(async () => {
    if (!user) return;
    await AsyncStorage.setItem(`${VOICE_ONBOARDING_SEEN_PREFIX}:${user.id}`, '1').catch(() => {});
  }, [user]);

  const leave = useCallback(async (step: 'skipped' | 'completed') => {
    await markSeen();
    trackOnboardingStep(step);
    router.replace('/(tabs)' as Href);
  }, [markSeen, router]);

  const beginRecording = useCallback(async () => {
    try {
      trackOnboardingStep('started');
      // Asked here, right after the explanation, rather than cold - and a denial explains that
      // typing still works instead of dead-ending.
      const status = await AudioModule.requestRecordingPermissionsAsync();
      if (!status.granted) {
        trackOnboardingStep('permission_denied');
        await markSeen();
        Alert.alert(
          'Microphone is off',
          'No problem. You can still type your notes, and turn the microphone on later in your device settings.',
          [{ text: 'Continue', onPress: () => router.replace('/(tabs)' as Href) }],
        );
        return;
      }
      trackOnboardingStep('permission_granted');
      await setAudioModeAsync({ playsInSilentMode: true, allowsRecording: true });
      await recorder.prepareToRecordAsync();
      recorder.record();
      startedAt.current = Date.now();
      trackVoiceRecordingStarted();
      setStage('listening');
    } catch (e) {
      console.error('Onboarding record failed:', e);
      Alert.alert('Could not start recording', 'Please try again.');
    }
  }, [markSeen, recorder, router]);

  const stopAndTranscribe = useCallback(async () => {
    try {
      setStage('transcribing');
      await recorder.stop();
      const uri = recorder.uri;
      const seconds = startedAt.current ? Math.round((Date.now() - startedAt.current) / 1000) : 0;
      startedAt.current = null;
      trackVoiceRecordingCompleted(seconds);
      if (!uri) throw new Error('no recording uri');

      const result = await transcribeApi.transcribe(uri);
      // The backend filters Whisper's silence hallucinations, so an empty result here genuinely
      // means nothing was said - the worst possible moment to show a confirmation screen quoting
      // an empty string.
      if (!result.text?.trim()) {
        setStage('ask');
        Alert.alert("Didn't catch that", 'We couldn’t hear anything that time. Tap the mic and try again.');
        return;
      }
      setTranscript(result.text.trim());
      trackOnboardingStep('recorded');
      setStage('review');
    } catch (e) {
      console.error('Onboarding transcription failed:', e);
      setStage('ask');
      Alert.alert('Could not transcribe', 'Please try again.');
    }
  }, [recorder]);

  const saveNote = useCallback(async () => {
    if (saving) return;
    setSaving(true);
    try {
      let text = transcript;
      if (tidy === 'organise') {
        try {
          const res = await textProcessApi.processText(transcript, 'organize');
          if (res?.text) text = res.text;
        } catch {
          // Tidying is a bonus - a failure here must not cost the user their first note.
        }
      }
      const { title, body } = splitTitleAndBody(text);
      const html = body
        .split(/\n{2,}/)
        .map(p => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`)
        .join('');

      await createNoteOffline({
        title,
        content: html,
        tags: [],
        is_pinned: false,
        linked_event_ids: [],
        images: [],
        attachments: [],
        objects: [],
      } as any, { push: true });

      const words = text.split(/\s+/).filter(Boolean).length;
      trackVoiceTranscriptionInserted(0, words);
      trackNoteCreated({ has_scheduled_event: false, has_image_attached: false, is_shared: false, source: 'voice' });
      trackOnboardingStep('note_saved');
      // The one celebration in the whole flow, and only ever on the first note.
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      await leave('completed');
    } catch (e) {
      console.error('Onboarding save failed:', e);
      Alert.alert('Could not save', 'Please try again.');
      setSaving(false);
    }
  }, [saving, transcript, tidy, leave]);

  // ---- ask -----------------------------------------------------------------
  if (stage === 'ask') {
    return (
      <SafeAreaView style={s.container} edges={['top', 'bottom']}>
        <View style={s.body}>
          <View style={s.micRing}>
            <Animated.View
              pointerEvents="none"
              style={[
                s.halo,
                {
                  opacity: halo.interpolate({ inputRange: [0, 0.15, 1], outputRange: [0, 0.35, 0] }),
                  transform: [{ scale: halo.interpolate({ inputRange: [0, 1], outputRange: [0.92, 1.5] }) }],
                },
              ]}
            />
            <View style={s.mic}>
              <MaterialIcons name="mic" size={36} color={C.primaryFg} />
            </View>
          </View>
          <Text style={s.title}>Nueco is fastest when you talk.</Text>
          <Text style={s.sub}>Say what’s on your mind and it becomes a note. No typing, no tidying.</Text>
        </View>
        <View style={s.actions}>
          {/* Stated at the moment of the ask rather than buried in settings. Framed as what the
              user GETS (their notes are encrypted) before the caveat (recordings are transcribed
              and discarded) - it's a reason to say yes, not a warning. */}
          <View style={s.privacyRow}>
            <MaterialIcons name="lock-outline" size={14} color={C.textSec} />
            <Text style={s.privacyText}>
              Your notes are encrypted on your phone. Recordings are only used to make text, and
              aren’t kept.
            </Text>
          </View>

          <TouchableOpacity style={s.cta} onPress={beginRecording} activeOpacity={0.85} testID="onboarding-start-voice">
            <Text style={s.ctaText}>Capture my first note</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={() => leave('skipped')} activeOpacity={0.7} testID="onboarding-skip">
            <Text style={s.skipText}>I’d rather type</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  // ---- listening / transcribing -------------------------------------------
  if (stage === 'listening' || stage === 'transcribing') {
    const busy = stage === 'transcribing';
    return (
      <SafeAreaView style={s.container} edges={['top', 'bottom']}>
        <View style={s.body}>
          <TouchableOpacity
            style={s.stopCircle}
            onPress={busy ? undefined : stopAndTranscribe}
            activeOpacity={0.85}
            disabled={busy}
            testID="onboarding-stop"
          >
            {busy ? <ActivityIndicator size="small" color={C.primary} /> : <View style={s.stopSquare} />}
          </TouchableOpacity>

          <View style={s.waveSlot}>
            {!busy && <RecordingWaveform getMetering={getMetering} />}
          </View>

          <Text style={s.listening}>{busy ? 'Turning it into words…' : 'Listening…'}</Text>
          {!busy && (
            // Deliberately free of dates and times: the voice-intent classifier reroutes anything
            // schedule-shaped to event creation, which would derail a first-run demo.
            <Text style={s.tryLine}>Try: “Things I want to remember about today.”</Text>
          )}
        </View>
        <View style={s.actions}>
          {!busy && (
            <TouchableOpacity onPress={stopAndTranscribe} activeOpacity={0.7}>
              <Text style={s.skipText}>Tap to stop</Text>
            </TouchableOpacity>
          )}
        </View>
      </SafeAreaView>
    );
  }

  // ---- review --------------------------------------------------------------
  const preview = splitTitleAndBody(transcript);
  return (
    <SafeAreaView style={s.container} edges={['top', 'bottom']}>
      <ScrollView contentContainerStyle={s.reviewScroll} showsVerticalScrollIndicator={false}>
        <Text style={s.reviewTitle}>Your first note</Text>

        <View style={s.noteCard}>
          {!!preview.title && <Text style={s.noteCardTitle}>{preview.title}</Text>}
          <Text style={s.noteCardBody}>{preview.body}</Text>
        </View>

        <Text style={s.tidyPrompt}>Want Nueco to tidy this up?</Text>

        <TouchableOpacity style={s.tidyRow} onPress={() => setTidy('keep')} activeOpacity={0.8} testID="tidy-keep">
          <Text style={[s.tidyLabel, tidy === 'keep' && s.tidyLabelOn]}>Keep it exactly as I said it</Text>
          {tidy === 'keep' && <MaterialIcons name="check" size={20} color={C.primary} />}
        </TouchableOpacity>

        <TouchableOpacity style={s.tidyRow} onPress={() => setTidy('organise')} activeOpacity={0.8} testID="tidy-organise">
          <Text style={[s.tidyLabel, tidy === 'organise' && s.tidyLabelOn]}>Organise into sections</Text>
          {tidy === 'organise' && <MaterialIcons name="check" size={20} color={C.primary} />}
        </TouchableOpacity>
      </ScrollView>

      <View style={s.actions}>
        <TouchableOpacity style={s.cta} onPress={saveNote} disabled={saving} activeOpacity={0.85} testID="onboarding-save-note">
          {saving ? <ActivityIndicator size="small" color={C.primaryFg} /> : <Text style={s.ctaText}>Save note</Text>}
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg, paddingHorizontal: 24 },
  body: { flex: 1, justifyContent: 'center', alignItems: 'center' },

  halo: {
    position: 'absolute', width: 116, height: 116, borderRadius: 58,
    borderWidth: 2, borderColor: C.secondary,
  },
  micRing: {
    width: 116, height: 116, borderRadius: 58, alignItems: 'center', justifyContent: 'center',
    borderWidth: 2, borderColor: C.secondary, marginBottom: 30,
  },
  mic: {
    width: 84, height: 84, borderRadius: 42, backgroundColor: C.primary,
    alignItems: 'center', justifyContent: 'center',
  },
  title: { fontSize: 25, fontWeight: '700', color: C.text, lineHeight: 32, alignSelf: 'stretch' },
  sub: { fontSize: 15, color: C.textSec, marginTop: 12, lineHeight: 22, alignSelf: 'stretch' },

  stopCircle: {
    width: 96, height: 96, borderRadius: 48, backgroundColor: C.secondaryTint,
    alignItems: 'center', justifyContent: 'center',
  },
  stopSquare: { width: 26, height: 26, borderRadius: 5, backgroundColor: C.primary },
  waveSlot: { height: 40, justifyContent: 'center', marginTop: 18 },
  listening: { fontSize: 21, fontWeight: '700', color: C.text, marginTop: 6, textAlign: 'center' },
  tryLine: { fontSize: 15, color: C.textSec, marginTop: 10, textAlign: 'center', lineHeight: 21 },

  reviewScroll: { paddingTop: 28, paddingBottom: 20, flexGrow: 1 },
  reviewTitle: { fontSize: 25, fontWeight: '700', color: C.text, marginBottom: 16 },
  noteCard: {
    backgroundColor: C.surface, borderRadius: 12, padding: 16, gap: 6,
    shadowColor: '#0A5443', shadowOpacity: 0.06, shadowRadius: 6, shadowOffset: { width: 0, height: 2 },
    elevation: 1,
  },
  noteCardTitle: { fontSize: 16, fontWeight: '700', color: C.text, lineHeight: 22 },
  noteCardBody: { fontSize: 15, color: C.textSec, lineHeight: 23 },
  tidyPrompt: { fontSize: 15, color: C.textSec, marginTop: 24, marginBottom: 10 },
  tidyRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    backgroundColor: C.surface, borderRadius: 12, paddingVertical: 15, paddingHorizontal: 16,
    marginBottom: 10,
    shadowColor: '#0A5443', shadowOpacity: 0.05, shadowRadius: 5, shadowOffset: { width: 0, height: 1 },
    elevation: 1,
  },
  tidyLabel: { fontSize: 15, color: C.text },
  tidyLabelOn: { fontWeight: '600' },

  privacyRow: {
    flexDirection: 'row', gap: 7, alignItems: 'flex-start',
    alignSelf: 'stretch', paddingHorizontal: 2, marginBottom: 4,
  },
  privacyText: { flex: 1, fontSize: 12, color: C.textSec, lineHeight: 17 },
  actions: { gap: 14, paddingBottom: 26, alignItems: 'center', minHeight: 44, justifyContent: 'flex-end' },
  cta: {
    backgroundColor: C.primary, paddingVertical: 16, borderRadius: 14,
    alignItems: 'center', justifyContent: 'center', alignSelf: 'stretch', minHeight: 54,
  },
  ctaText: { color: C.primaryFg, fontSize: 17, fontWeight: '600' },
  skipText: { color: C.borderSub, fontSize: 15, fontWeight: '500', paddingVertical: 6 },
});
