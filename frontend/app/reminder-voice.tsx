/**
 * Onboarding step — how reminders should sound.
 *
 * Thin wrapper: the actual controls live in ReminderVoicePicker, shared with Settings so both
 * places offer exactly the same options and there's one implementation to keep correct.
 *
 * Both options are entirely on-device (a locally recorded clip, or the OS speech engine).
 * Deliberately NOT a cloud TTS service: speaking a reminder through one means sending the
 * reminder's text to that vendor, which is exactly what the rest of this app is built to avoid.
 */
import React, { useCallback, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { MaterialIcons } from '@expo/vector-icons';
import { useRouter, type Href } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useAuth } from '../src/auth/context/AuthContext';
import { trackOnboardingStep } from '../src/analytics';
import { ReminderVoicePicker, REMINDER_VOICE_PREF_KEY, type ReminderVoiceMode } from '../src/components/ReminderVoicePicker';
import { C } from '../src/theme';

export const REMINDER_VOICE_SEEN_PREFIX = 'reminder_voice_onboarding_seen';

export default function ReminderVoiceScreen() {
  const router = useRouter();
  const { user } = useAuth();
  // The picker persists every change itself; this only drives the confirm button's enabled state.
  const [mode, setMode] = useState<ReminderVoiceMode>('off');

  const finish = useCallback(async (accepted: boolean) => {
    if (user) {
      await AsyncStorage.setItem(`${REMINDER_VOICE_SEEN_PREFIX}:${user.id}`, '1').catch(() => {});
    }
    // "Not now" has to clear whatever the picker already wrote - otherwise a voice that was tried
    // and then backed out of would silently stay in effect.
    if (!accepted) {
      await AsyncStorage.setItem(REMINDER_VOICE_PREF_KEY, JSON.stringify({ mode: 'off' })).catch(() => {});
    }
    trackOnboardingStep(accepted && mode !== 'off' ? 'completed' : 'skipped');
    router.replace('/(tabs)' as Href);
  }, [user, mode, router]);

  return (
    <SafeAreaView style={s.container} edges={['top', 'bottom']}>
      <ScrollView contentContainerStyle={s.scroll} showsVerticalScrollIndicator={false}>
        <Text style={s.title}>Want your reminders spoken?</Text>
        <Text style={s.sub}>Change it any time in settings.</Text>

        <ReminderVoicePicker onModeChange={setMode} />

        <View style={s.privacyRow}>
          <MaterialIcons name="lock-outline" size={15} color={C.textSec} />
          <Text style={s.privacyText}>
            Both options run entirely on your phone. Nothing is sent to us or anyone else.
          </Text>
        </View>
      </ScrollView>

      <View style={s.actions}>
        <TouchableOpacity
          style={[s.cta, mode === 'off' && s.ctaDisabled]}
          onPress={() => finish(true)}
          disabled={mode === 'off'}
          activeOpacity={0.85}
          testID="reminder-voice-confirm"
        >
          <Text style={s.ctaText}>Use this voice</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={() => finish(false)} activeOpacity={0.7} testID="reminder-voice-skip">
          <Text style={s.skipText}>Not now</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg, paddingHorizontal: 24 },
  scroll: { paddingTop: 36, paddingBottom: 20, flexGrow: 1 },
  title: { fontSize: 25, fontWeight: '700', color: C.text, lineHeight: 32 },
  sub: { fontSize: 14, color: C.textSec, marginTop: 8, marginBottom: 14 },
  privacyRow: { flexDirection: 'row', gap: 8, alignItems: 'flex-start', marginTop: 26 },
  privacyText: { flex: 1, fontSize: 12.5, color: C.textSec, lineHeight: 18 },
  actions: { gap: 14, paddingBottom: 24, alignItems: 'center' },
  cta: {
    backgroundColor: C.primary, paddingVertical: 16, borderRadius: 14,
    alignItems: 'center', justifyContent: 'center', alignSelf: 'stretch', minHeight: 54,
  },
  ctaDisabled: { opacity: 0.45 },
  ctaText: { color: C.primaryFg, fontSize: 17, fontWeight: '600' },
  skipText: { color: C.borderSub, fontSize: 15, fontWeight: '500', paddingVertical: 6 },
});
