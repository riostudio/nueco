/**
 * google-connect-intro.tsx
 * One-time onboarding step that asks whether the user wants to connect their Google Calendar
 * to Nueco - shown right after login (chained from the tabs layout, after the analytics
 * consent step) and as part of the first-run onboarding journey. Explicitly NOT age-skipped
 * like the voice/daily-lift steps: existing accounts updating into this build get asked once
 * too. Either choice records `google_connect_onboarding_seen:<uid>` and the chain moves on;
 * "Not now" users can always connect later from Settings → Calendar sync.
 *
 * Connect runs the same flow as app/google-calendar-settings.tsx: consent (login_hint for
 * Gmail accounts), then auto-picks the calendar when there's exactly one writable calendar,
 * otherwise swaps this screen into a picker. First sync starts immediately on selection.
 */
import React, { useEffect, useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, Alert, ScrollView,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { MaterialIcons } from '@expo/vector-icons';
import { useRouter, type Href } from 'expo-router';
import { useAuth } from '../src/auth';
import { C, radius } from '../src/theme';
import { Button } from '../src/components';
import { connectGoogleAccount, getValidAccessToken, isGoogleConnected } from '../src/google/auth';
import { listCalendars, type GoogleCalendar } from '../src/google/calendarApi';
import { setSelectedGoogleCalendar, runGoogleSync } from '../src/google/googleSync';

export default function GoogleConnectIntroScreen() {
  const router = useRouter();
  const { user } = useAuth();
  const [connecting, setConnecting] = useState(false);
  const [calendars, setCalendars] = useState<GoogleCalendar[] | null>(null);

  const seenKey = `google_connect_onboarding_seen:${user?.id}`;
  const done = async () => {
    try { await AsyncStorage.setItem(seenKey, '1'); } catch {}
    router.replace('/(tabs)' as Href);
  };

  // If already connected or already answered (e.g. reached by accident), move on.
  useEffect(() => {
    (async () => {
      const seen = await AsyncStorage.getItem(seenKey).catch(() => null);
      if (seen || (await isGoogleConnected().catch(() => false))) done();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pickCalendar = async (cal: GoogleCalendar) => {
    await setSelectedGoogleCalendar({
      id: cal.id,
      summary: cal.summary,
      timeZone: cal.timeZone ?? null,
    });
    runGoogleSync({ force: true }).catch(() => {});
    await done();
  };

  const handleConnect = async () => {
    setConnecting(true);
    try {
      const email = user?.email;
      const hint = email && /@(gmail|googlemail)\.com$/i.test(email) ? email : undefined;
      const tokens = await connectGoogleAccount(hint);
      if (!tokens) return; // user closed the browser - stay on this screen for a retry
      const token = await getValidAccessToken();
      if (!token) return;
      const list = await listCalendars(token);
      if (list.length === 0) {
        Alert.alert('No writable Google calendars found on this account.');
        await done();
        return;
      }
      if (list.length === 1) await pickCalendar(list[0]);
      else setCalendars(list);
    } catch (e: any) {
      Alert.alert('Couldn’t connect Google Calendar', e?.message || 'Have another go in a moment.');
    } finally {
      setConnecting(false);
    }
  };

  return (
    <SafeAreaView style={s.container}>
      {calendars === null ? (
        <>
          <View style={s.content}>
            <View style={s.iconCircle}>
              <MaterialIcons name="event-available" size={48} color={C.primary} />
            </View>
            <Text style={s.title}>Sync your Google Calendar?</Text>
            <Text style={s.body}>
              Keep Nueco events and one Google calendar in sync, both ways - create or edit in
              either app and it shows up in the other.
            </Text>
            <Text style={s.reassure}>
              Your Google sign-in stays on this device; Nueco’s server never sees it. You can
              disconnect anytime in Settings → Calendar sync.
            </Text>
          </View>

          <View style={s.actions}>
            <Button
              testID="google-intro-connect"
              variant="cta"
              label="Connect Google Calendar"
              onPress={handleConnect}
              loading={connecting}
            />
            <TouchableOpacity
              testID="google-intro-skip"
              style={s.denyBtn}
              onPress={done}
              activeOpacity={0.7}
            >
              <Text style={s.denyText}>Not now</Text>
            </TouchableOpacity>
          </View>
        </>
      ) : (
        <>
          <View style={[s.content, { justifyContent: 'flex-start', paddingTop: 60 }]}>
            <Text style={s.title}>Which calendar?</Text>
            <Text style={s.reassure}>Pick the Google calendar Nueco should stay in sync with.</Text>
            <ScrollView style={s.pickList} contentContainerStyle={{ paddingBottom: 24 }}>
              {calendars.map((cal) => (
                <TouchableOpacity
                  key={cal.id}
                  testID={`google-intro-calendar-${cal.id}`}
                  style={s.row}
                  onPress={() => pickCalendar(cal)}
                  activeOpacity={0.7}
                >
                  <MaterialIcons name="calendar-today" size={22} color={C.primary} />
                  <Text style={s.rowLabel} numberOfLines={1}>
                    {cal.summary}{cal.primary ? ' · Primary' : ''}
                  </Text>
                  <MaterialIcons name="chevron-right" size={22} color={C.borderSub} />
                </TouchableOpacity>
              ))}
            </ScrollView>
          </View>
          <View style={s.actions}>
            <TouchableOpacity style={s.denyBtn} onPress={done} activeOpacity={0.7}>
              <Text style={s.denyText}>Skip for now</Text>
            </TouchableOpacity>
          </View>
        </>
      )}
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg, justifyContent: 'space-between' },
  content: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 28 },
  iconCircle: {
    width: 96, height: 96, borderRadius: radius.pill, backgroundColor: C.surfaceHi,
    alignItems: 'center', justifyContent: 'center', marginBottom: 28,
  },
  title: { fontSize: 28, fontWeight: '700', color: C.text, textAlign: 'center', marginBottom: 16 },
  body: { fontSize: 19, color: C.text, textAlign: 'center', lineHeight: 28, marginBottom: 16 },
  reassure: { fontSize: 16, color: C.textSec, textAlign: 'center', lineHeight: 24 },
  actions: { paddingHorizontal: 24, paddingBottom: 24, gap: 8 },
  denyBtn: { height: 52, alignItems: 'center', justifyContent: 'center' },
  denyText: { fontSize: 17, fontWeight: '600', color: C.textSec },
  pickList: { marginTop: 24, width: '100%' },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    backgroundColor: C.surface, borderRadius: radius.md,
    paddingVertical: 16, paddingHorizontal: 16, marginBottom: 10,
  },
  rowLabel: { flex: 1, fontSize: 17, color: C.text, fontWeight: '500' },
});
