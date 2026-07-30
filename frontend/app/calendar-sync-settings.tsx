import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, Switch, ActivityIndicator, Alert } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { MaterialIcons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import {
  isCalendarSyncEnabled,
  setCalendarSyncEnabled,
  getSyncedCalendarIds,
  setSyncedCalendarIds,
  getAllDeviceCalendars,
  runCalendarSync,
} from '../src/calendarSync';
import { C } from '../src/theme';

type DeviceCalendar = { id: string; title: string; source?: string };

export default function CalendarSyncSettingsScreen() {
  const router = useRouter();
  const [enabled, setEnabled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [calendars, setCalendars] = useState<DeviceCalendar[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [syncing, setSyncing] = useState(false);
  const [lastSyncedAt, setLastSyncedAt] = useState<Date | null>(null);

  useEffect(() => {
    (async () => {
      const isEnabled = await isCalendarSyncEnabled();
      setEnabled(isEnabled);
      setSelectedIds(await getSyncedCalendarIds());
      // Sync was already on from a previous visit - reload the calendar list too, otherwise it
      // stays empty until the toggle is flipped again.
      if (isEnabled) setCalendars(await getAllDeviceCalendars());
      setLoading(false);
    })();
  }, []);

  const showSyncInfo = useCallback(() => {
    Alert.alert(
      'About Calendar Sync',
      "New, changed, and deleted events sync in whenever you open Nueco. A best-effort background sync also runs periodically, but the OS doesn't guarantee exact timing - opening the app (or tapping Sync Now below) is what reliably keeps things up to date.\n\nIf a synced calendar includes events other people created or invited you to (for example a shared work calendar or a meeting invite), those event details are copied into Nueco too.",
    );
  }, []);

  const toggleEnabled = useCallback(async (value: boolean) => {
    setEnabled(value);
    await setCalendarSyncEnabled(value);
    if (value) {
      const cals = await getAllDeviceCalendars();
      setCalendars(cals);
      if (!cals.length) {
        Alert.alert('Calendar', 'Calendar access is needed, or no calendars were found. You can enable access in Settings.');
      }
    }
  }, []);

  const toggleCalendar = useCallback((id: string) => {
    // Side effects (AsyncStorage write + kicking off a sync) computed and run outside the
    // updater, not inside it - React documents that setState updaters must be pure since it may
    // invoke them more than once (Strict Mode, concurrent rendering); this app doesn't use
    // StrictMode today so it's harmless in practice, but doing it right costs nothing here.
    const next = selectedIds.includes(id) ? selectedIds.filter((x) => x !== id) : [...selectedIds, id];
    setSelectedIds(next);
    setSyncedCalendarIds(next).then(() => runCalendarSync({ force: true }).catch(() => {}));
  }, [selectedIds]);

  const syncNow = useCallback(async () => {
    setSyncing(true);
    try {
      await runCalendarSync({ force: true });
      setLastSyncedAt(new Date());
    } finally {
      setSyncing(false);
    }
  }, []);

  if (loading) {
    return (
      <SafeAreaView style={s.container}>
        <View style={s.center}><ActivityIndicator size="large" color={C.primary} /></View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={s.container}>
      <View style={s.header}>
        <TouchableOpacity onPress={() => router.back()} style={s.backBtn}>
          <MaterialIcons name="arrow-back" size={28} color={C.textSec} />
        </TouchableOpacity>
        <Text style={s.headerTitle}>Calendar Sync</Text>
        <View style={{ width: 48 }} />
      </View>

      <ScrollView style={s.scroll} contentContainerStyle={s.scrollContent}>
        <View style={[s.card, s.toggleCard]}>
          <View style={s.toggleRow}>
            <MaterialIcons name="sync" size={24} color={C.textSec} />
            <View style={{ flex: 1, marginLeft: 16 }}>
              <View style={s.subRow}>
                <Text style={s.rowLabelPlain}>Auto-sync calendar events</Text>
                <TouchableOpacity
                  testID="calendar-sync-info-btn"
                  onPress={showSyncInfo}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                >
                  <MaterialIcons name="info-outline" size={16} color={C.textSec} style={s.infoIcon} />
                </TouchableOpacity>
              </View>
              <Text style={s.rowSub}>Pull events from your phone's calendars automatically</Text>
            </View>
            <Switch
              testID="calendar-sync-toggle"
              value={enabled}
              onValueChange={toggleEnabled}
              trackColor={{ false: C.borderSub, true: C.primary + '80' }}
              thumbColor={enabled ? C.primary : '#f4f3f4'}
            />
          </View>
        </View>

        {enabled && (
          <View style={[s.card, { marginTop: 20 }]}>
            <Text style={s.sectionLabel}>Calendars to sync</Text>
            {calendars.length === 0 ? (
              <Text style={s.rowSub}>No calendars found, or access hasn't been granted yet.</Text>
            ) : (
              calendars.map((cal) => {
                const selected = selectedIds.includes(cal.id);
                return (
                  <TouchableOpacity
                    key={cal.id}
                    testID={`calendar-sync-item-${cal.id}`}
                    style={s.row}
                    onPress={() => toggleCalendar(cal.id)}
                  >
                    <MaterialIcons
                      name={selected ? 'check-box' : 'check-box-outline-blank'}
                      size={24}
                      color={selected ? C.primary : C.borderSub}
                    />
                    <Text style={s.rowLabel} numberOfLines={1}>
                      {cal.title}{cal.source ? ` · ${cal.source}` : ''}
                    </Text>
                  </TouchableOpacity>
                );
              })
            )}
          </View>
        )}

        {enabled && (
          <TouchableOpacity
            testID="calendar-sync-now-btn"
            style={[s.card, s.syncNowCard]}
            onPress={syncNow}
            disabled={syncing}
          >
            {syncing ? (
              <ActivityIndicator size="small" color={C.primary} />
            ) : (
              <MaterialIcons name="sync" size={20} color={C.primary} />
            )}
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
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
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
  card: {
    backgroundColor: C.surface, padding: 20,
  },
  toggleCard: { paddingVertical: 24, paddingHorizontal: 24 },
  syncNowCard: {
    marginTop: 20, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10,
  },
  syncNowText: { fontSize: 16, fontWeight: '600', color: C.primary },
  sectionLabel: { fontSize: 16, fontWeight: '600', color: C.textSec, marginBottom: 12 },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10 },
  toggleRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 8, paddingHorizontal: 4 },
  rowLabel: { fontSize: 18, color: C.text, marginLeft: 16, flex: 1, fontWeight: '500' },
  rowLabelPlain: { fontSize: 18, color: C.text },
  rowSub: { fontSize: 14, color: C.textSec, marginTop: 6, lineHeight: 20 },
  subRow: { flexDirection: 'row', alignItems: 'center' },
  infoIcon: { marginLeft: 6 },
});
