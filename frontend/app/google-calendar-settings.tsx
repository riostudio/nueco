/**
 * app/google-calendar-settings.tsx
 * Connect/disconnect Google Calendar and pick which Google calendar Nueco syncs with.
 * Shown from the Calendar settings screen (calendar-sync-settings.tsx).
 */
import React, { useCallback, useEffect, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator, Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { MaterialIcons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { C } from '../src/theme';
import {
  isGoogleConnectAvailable,
  connectGoogleAccount,
  getStoredTokens,
  getValidAccessToken,
} from '../src/google/auth';
import { listCalendars, type GoogleCalendar } from '../src/google/calendarApi';
import {
  getSelectedGoogleCalendar,
  setSelectedGoogleCalendar,
  runGoogleSync,
  disconnectGoogleSync,
} from '../src/google/googleSync';

export default function GoogleCalendarSettingsScreen() {
  const router = useRouter();
  const [available] = useState(isGoogleConnectAvailable());
  const [connectedEmail, setConnectedEmail] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [loadingCalendars, setLoadingCalendars] = useState(false);
  const [calendars, setCalendars] = useState<GoogleCalendar[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [lastSyncedAt, setLastSyncedAt] = useState<Date | null>(null);

  const loadState = useCallback(async () => {
    const tokens = await getStoredTokens();
    setConnectedEmail(tokens?.email ?? null);
    const selected = await getSelectedGoogleCalendar();
    setSelectedId(selected?.id ?? null);
    if (tokens?.accessToken) {
      setLoadingCalendars(true);
      try {
        const token = await getValidAccessToken();
        if (token) setCalendars(await listCalendars(token));
      } catch (e) {
        console.warn('Failed to list Google calendars:', e);
      } finally {
        setLoadingCalendars(false);
      }
    } else {
      setCalendars([]);
    }
  }, []);

  useEffect(() => { loadState(); }, [loadState]);

  const handleConnect = useCallback(async () => {
    setConnecting(true);
    try {
      const tokens = await connectGoogleAccount();
      if (!tokens) return; // dismissed
      setConnectedEmail(tokens.email);
      await loadState();
    } catch (e: any) {
      Alert.alert('Couldn’t connect Google Calendar', e?.message || 'Have another go in a moment.');
    } finally {
      setConnecting(false);
    }
  }, [loadState]);

  const chooseCalendar = useCallback(async (cal: GoogleCalendar) => {
    setSelectedId(cal.id);
    await setSelectedGoogleCalendar({
      id: cal.id,
      summary: cal.summary,
      timeZone: cal.timeZone ?? null,
    });
    // A first sync right away makes the connection feel real: events show up without waiting
    // for the next app-open trigger.
    setSyncing(true);
    try {
      await runGoogleSync({ force: true });
      setLastSyncedAt(new Date());
    } finally {
      setSyncing(false);
    }
  }, []);

  const syncNow = useCallback(async () => {
    setSyncing(true);
    try {
      await runGoogleSync({ force: true });
      setLastSyncedAt(new Date());
    } finally {
      setSyncing(false);
    }
  }, []);

  const handleDisconnect = useCallback(() => {
    Alert.alert(
      'Disconnect Google Calendar?',
      'Nueco will stop syncing with Google. Events already copied into Nueco stay here; nothing is deleted from Google.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Disconnect',
          style: 'destructive',
          onPress: async () => {
            await disconnectGoogleSync();
            setConnectedEmail(null);
            setCalendars([]);
            setSelectedId(null);
          },
        },
      ],
    );
  }, []);

  return (
    <SafeAreaView style={s.container}>
      <View style={s.header}>
        <TouchableOpacity onPress={() => router.back()} style={s.backBtn}>
          <MaterialIcons name="arrow-back" size={28} color={C.textSec} />
        </TouchableOpacity>
        <Text style={s.headerTitle}>Google Calendar</Text>
        <View style={{ width: 48 }} />
      </View>

      <ScrollView style={s.scroll} contentContainerStyle={s.scrollContent}>
        {!available && (
          <View style={s.card}>
            <Text style={s.rowSub}>
              Google Calendar connect isn’t set up in this build yet.
            </Text>
          </View>
        )}

        {available && !connectedEmail && (
          <View style={s.card}>
            <Text style={s.sectionLabel}>Connect</Text>
            <Text style={s.rowSub}>
              Sync events both ways between Nueco and one Google calendar of your choice. Your
              Google sign-in stays on this device - Nueco’s server never sees it.
            </Text>
            <TouchableOpacity
              testID="google-connect-btn"
              style={s.primaryBtn}
              onPress={handleConnect}
              disabled={connecting}
            >
              {connecting
                ? <ActivityIndicator size="small" color="#FFFFFF" />
                : <Text style={s.primaryBtnText}>Connect Google account</Text>}
            </TouchableOpacity>
          </View>
        )}

        {connectedEmail && (
          <View style={s.card}>
            <View style={s.accountRow}>
              <MaterialIcons name="account-circle" size={28} color={C.primary} />
              <View style={{ flex: 1, marginLeft: 12 }}>
                <Text style={s.rowLabelPlain}>Connected</Text>
                <Text style={s.rowSub} numberOfLines={1}>{connectedEmail}</Text>
              </View>
              <TouchableOpacity
                testID="google-disconnect-btn"
                onPress={handleDisconnect}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              >
                <Text style={{ color: C.danger, fontSize: 15, fontWeight: '600' }}>Disconnect</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}

        {connectedEmail && (
          <View style={[s.card, { marginTop: 20 }]}>
            <Text style={s.sectionLabel}>Calendar to sync</Text>
            {loadingCalendars ? (
              <View style={s.centerPad}><ActivityIndicator size="small" color={C.primary} /></View>
            ) : calendars.length === 0 ? (
              <Text style={s.rowSub}>No writable Google calendars found on this account.</Text>
            ) : (
              calendars.map((cal) => {
                const selected = selectedId === cal.id;
                return (
                  <TouchableOpacity
                    key={cal.id}
                    testID={`google-calendar-item-${cal.id}`}
                    style={s.row}
                    onPress={() => chooseCalendar(cal)}
                    disabled={syncing}
                  >
                    <MaterialIcons
                      name={selected ? 'radio-button-checked' : 'radio-button-unchecked'}
                      size={24}
                      color={selected ? C.primary : C.borderSub}
                    />
                    <View style={{ flex: 1, marginLeft: 16 }}>
                      <Text style={s.rowLabel} numberOfLines={1}>
                        {cal.summary}{cal.primary ? ' · Primary' : ''}
                      </Text>
                    </View>
                  </TouchableOpacity>
                );
              })
            )}
          </View>
        )}

        {connectedEmail && selectedId && (
          <TouchableOpacity
            testID="google-sync-now-btn"
            style={[s.card, s.syncNowCard]}
            onPress={syncNow}
            disabled={syncing}
          >
            {syncing
              ? <ActivityIndicator size="small" color={C.primary} />
              : <MaterialIcons name="sync" size={20} color={C.primary} />}
            <Text style={s.syncNowText}>
              {syncing ? 'Syncing…' : lastSyncedAt ? `Synced ${lastSyncedAt.toLocaleTimeString()}` : 'Sync Now'}
            </Text>
          </TouchableOpacity>
        )}

        <View style={{ height: 40 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingTop: 12,
    paddingBottom: 12,
  },
  backBtn: { padding: 12 },
  headerTitle: { fontSize: 22, fontWeight: '700', color: C.text },
  scroll: { flex: 1 },
  scrollContent: { paddingHorizontal: 24, paddingTop: 8 },
  card: { backgroundColor: C.surface, padding: 20 },
  centerPad: { paddingVertical: 12, alignItems: 'center' },
  sectionLabel: { fontSize: 16, fontWeight: '600', color: C.textSec, marginBottom: 12 },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10 },
  rowLabel: { fontSize: 18, color: C.text, fontWeight: '500' },
  rowLabelPlain: { fontSize: 18, color: C.text },
  rowSub: { fontSize: 14, color: C.textSec, marginTop: 4, lineHeight: 20 },
  accountRow: { flexDirection: 'row', alignItems: 'center' },
  primaryBtn: {
    marginTop: 16, paddingVertical: 14, borderRadius: 12,
    backgroundColor: C.primary, alignItems: 'center',
  },
  primaryBtnText: { fontSize: 16, fontWeight: '600', color: '#FFFFFF' },
  syncNowCard: {
    marginTop: 20, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10,
  },
  syncNowText: { fontSize: 16, fontWeight: '600', color: C.primary },
});
