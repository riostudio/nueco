import React, { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, FlatList,
  RefreshControl, ActivityIndicator, Alert, Animated, Platform,
  NativeSyntheticEvent, NativeScrollEvent, Modal,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { MaterialIcons } from '@expo/vector-icons';
import { useRouter, useFocusEffect } from 'expo-router';
import { useIsFocused } from '@react-navigation/native';
import { deleteEventOffline, getLocalEvents, fullSync } from '../../src/offlineSync';
import { bumpDeviceCalendarSync } from '../../src/deviceCalendarSync';
import { CalendarEvent } from '../../src/types';
import { C, radius, borderWidth } from '../../src/theme';
import { MONTH_NAMES, DAY_NAMES } from '../../src/dateNames';
import { UserAvatar } from '../../src/auth';
import { SegmentedControl } from '../../src/components';
import { nextOccurrenceOnOrAfter, formatRecurrenceSummary } from '../../src/recurrence';

let ExpoCalendar: typeof import('expo-calendar') | null = null;
if (Platform.OS !== 'web') {
  try { ExpoCalendar = require('expo-calendar'); } catch {}
}

function formatEventTime(iso: string): string {
  const d = new Date(iso);
  const h = d.getHours();
  const m = d.getMinutes();
  const ampm = h >= 12 ? 'PM' : 'AM';
  const hour = h % 12 || 12;
  return `${hour}:${m.toString().padStart(2, '0')} ${ampm}`;
}

function formatEventDate(iso: string): string {
  const d = new Date(iso);
  return `${DAY_NAMES[d.getDay()]}, ${MONTH_NAMES[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

function isEventToday(iso: string): boolean {
  const d = new Date(iso);
  const now = new Date();
  return d.getDate() === now.getDate() &&
    d.getMonth() === now.getMonth() &&
    d.getFullYear() === now.getFullYear();
}

function formatReminderMinutes(minutes: number | null | undefined): string {
  if (!minutes) return '';
  if (minutes === 5) return '5 min before';
  if (minutes === 15) return '15 min before';
  if (minutes === 30) return '30 min before';
  if (minutes === 60) return '1 hr before';
  if (minutes === 1440) return '1 day before';
  return `${minutes} min before`;
}

// The effective datetime a recurring event should be treated as occurring at - its next
// upcoming occurrence, not the original series-creation start_time - falling back to start_time
// once the series has ended (nextOccurrenceOnOrAfter returns null past `until`) so an ended
// series still shows up somewhere instead of silently disappearing. Shared by the Upcoming
// filter and the day-grouping below so both agree on what "today"/"upcoming" means for a series.
function effectiveEventDate(evt: CalendarEvent): Date {
  if (!evt.recurrence) return new Date(evt.start_time);
  return nextOccurrenceOnOrAfter(evt, new Date()) ?? new Date(evt.start_time);
}

function isEventUpcoming(iso: string): boolean {
  return new Date(iso) >= new Date(new Date().setHours(0, 0, 0, 0));
}

// Local calendar-day key (not UTC) - dateKey used to come from the UTC ISO substring while
// formatEventDate/isEventToday below both read local date fields, so events near local midnight
// could land under the wrong day header or split the same local day across two mislabeled groups.
function localDateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

type GroupedEvents = { date: string; displayDate: string; isToday: boolean; events: CalendarEvent[] }[];

function groupEventsByDate(events: CalendarEvent[]): GroupedEvents {
  const map = new Map<string, { displayDate: string; isToday: boolean; entries: { evt: CalendarEvent; displayDate: Date }[] }>();

  for (const evt of events) {
    const displayDate = effectiveEventDate(evt);
    const dateKey = localDateKey(displayDate);
    if (!map.has(dateKey)) {
      map.set(dateKey, {
        displayDate: formatEventDate(displayDate.toISOString()),
        isToday: isEventToday(displayDate.toISOString()),
        entries: [],
      });
    }
    map.get(dateKey)!.entries.push({ evt, displayDate });
  }

  return Array.from(map.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, val]) => ({
      date,
      displayDate: val.displayDate,
      isToday: val.isToday,
      // Chronological within the day - entries.push order above is arbitrary (whatever
      // getLocalEvents() happened to return), and comparing recurring events' displayDate
      // (their actual next-occurrence time) rather than raw start_time keeps a same-day
      // recurring event correctly ordered against one-off events instead of sorting by its
      // original (possibly months-old) creation timestamp.
      events: val.entries.sort((a, b) => a.displayDate.getTime() - b.displayDate.getTime()).map((e) => e.evt),
    }));
}

export default function EventsScreen() {
  const router = useRouter();
  const isFocused = useIsFocused();
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [filter, setFilter] = useState<'upcoming' | 'all'>('upcoming');
  const [fabExpanded, setFabExpanded] = useState(false);
  const fabWidth = useRef(new Animated.Value(64)).current; // collapsed size matches Notes/Calendar FAB height
  const textOpacity = useRef(new Animated.Value(0)).current;
  const lastScrollY = useRef(0);

  // Delete confirmation modal state
  const [deleteModalVisible, setDeleteModalVisible] = useState(false);
  const [eventToDelete, setEventToDelete] = useState<{ id: string; title: string; deviceCalendarEventId: string | null } | null>(null);
  const [deleting, setDeleting] = useState(false);

  // Local-first, same pattern (tabs)/index.tsx uses for notes: show what's already on disk
  // instantly (including anything still sitting in the offline retry queue - see
  // offlineSync.ts), then reconcile with the server. Replaces the previous network-only fetch
  // + its own ad-hoc AsyncStorage cache with the shared offline store.
  const loadEvents = useCallback(async (force?: boolean) => {
    try {
      const local = await getLocalEvents();
      setEvents(local.filter(e => !e._pendingDelete) as CalendarEvent[]);
      await fullSync({ force });
      const fresh = await getLocalEvents();
      setEvents(fresh.filter(e => !e._pendingDelete) as CalendarEvent[]);
    } catch (e) {
      console.error('Failed to load events:', e);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useFocusEffect(useCallback(() => { loadEvents(); }, [loadEvents]));

  // Polling for sync across devices - check for updates every 30 seconds, only while this tab
  // is actually the one visible. expo-router's Tabs navigator keeps all three tab screens
  // mounted for fast switching, so without a real isFocused check this fired in parallel on
  // whichever tabs weren't even on screen - wasted battery/data for no benefit.
  useEffect(() => {
    const pollInterval = setInterval(() => {
      if (!refreshing && !loading && isFocused) {
        loadEvents();
      }
    }, 30000); // 30 seconds

    return () => clearInterval(pollInterval);
  }, [loadEvents, refreshing, loading, isFocused]);

  const handleDeletePress = (eventId: string, eventTitle: string, deviceCalendarEventId: string | null) => {
    setEventToDelete({ id: eventId, title: eventTitle || 'Untitled Event', deviceCalendarEventId });
    setDeleteModalVisible(true);
  };

  const confirmDelete = async () => {
    if (!eventToDelete) return;
    setDeleting(true);
    try {
      // Mirrors event-editor.tsx's delete: also remove the device-calendar copy for events
      // linked via "Import from Calendar" or calendar sync, so deleting here doesn't leave
      // an orphaned event behind in the user's Apple/Google/Outlook calendar.
      if (ExpoCalendar && eventToDelete.deviceCalendarEventId && Platform.OS !== 'web') {
        try { await ExpoCalendar.deleteEventAsync(eventToDelete.deviceCalendarEventId); bumpDeviceCalendarSync(); } catch {}
      }
      await deleteEventOffline(eventToDelete.id, { push: true });
      loadEvents();
      setDeleteModalVisible(false);
      setEventToDelete(null);
    } catch (e) {
      console.error('Delete failed:', e);
    } finally {
      setDeleting(false);
    }
  };

  const cancelDelete = () => {
    setDeleteModalVisible(false);
    setEventToDelete(null);
  };

  const expandFab = () => {
    if (fabExpanded) return;
    setFabExpanded(true);
    Animated.parallel([
      Animated.spring(fabWidth, { toValue: 200, useNativeDriver: false, friction: 8 }),
      Animated.timing(textOpacity, { toValue: 1, duration: 200, useNativeDriver: false }),
    ]).start();
  };

  const collapseFab = () => {
    if (!fabExpanded) return;
    setFabExpanded(false);
    Animated.parallel([
      Animated.spring(fabWidth, { toValue: 64, useNativeDriver: false, friction: 8 }),
      Animated.timing(textOpacity, { toValue: 0, duration: 150, useNativeDriver: false }),
    ]).start();
  };

  const handleScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const currentY = e.nativeEvent.contentOffset.y;
    const scrollingDown = currentY > lastScrollY.current && currentY > 10;
    
    if (scrollingDown) {
      expandFab();
    } else if (currentY <= 10) {
      collapseFab();
    }
    
    lastScrollY.current = currentY;
  };

  // For a recurring event, start_time is the original series-creation timestamp - checking it
  // directly against "today" silently drops any series created before today from the default
  // Upcoming view, even though it clearly still occurs again. Use the same effectiveEventDate
  // (next occurrence) groupEventsByDate already computes for exactly this reason.
  //
  // Memoized: groupEventsByDate does an O(n) pass computing each event's effective (recurrence-
  // aware) date plus a sort, and this screen re-renders on state changes that have nothing to
  // do with the event data - notably handleScroll's FAB-expand/collapse toggling during normal
  // list scrolling (scrollEventThrottle=16). Without memoization every one of those re-renders
  // redid the full filter+group+sort pass.
  const filteredEvents = useMemo(
    () =>
      filter === 'upcoming'
        ? events.filter((e) => isEventUpcoming(effectiveEventDate(e).toISOString()))
        : events,
    [events, filter]
  );

  const grouped = useMemo(() => groupEventsByDate(filteredEvents), [filteredEvents]);

  // Only block on a spinner when there's nothing cached yet; otherwise render cached events instantly.
  if (loading && events.length === 0) {
    return (
      <SafeAreaView style={s.container} edges={['top']}>
        <View style={s.center}>
          <ActivityIndicator size="large" color={C.primary} />
          <Text style={s.loadText}>Loading events...</Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={s.container} edges={['top']}>
      <View style={s.header}>
        <Text style={s.headerTitle}>Events</Text>
        <View style={s.headerActions}>
          <TouchableOpacity
            testID="trips-btn"
            style={s.headerIconBtn}
            onPress={() => router.push('/trips')}
            activeOpacity={0.7}
          >
            <MaterialIcons name="luggage" size={24} color={C.text} />
          </TouchableOpacity>
          <UserAvatar size={36} />
        </View>
      </View>

      {/* Filter Toggle */}
      <SegmentedControl
        style={s.filterRow}
        value={filter}
        onChange={setFilter}
        options={[
          { label: 'Upcoming', value: 'upcoming', testID: 'filter-upcoming-btn' },
          { label: 'All Events', value: 'all', testID: 'filter-all-btn' },
        ]}
      />

      <FlatList
        style={s.scroll}
        contentContainerStyle={s.scrollContent}
        data={grouped}
        keyExtractor={(item) => item.date}
        onScroll={handleScroll}
        scrollEventThrottle={16}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => { setRefreshing(true); loadEvents(true); }}
            colors={[C.primary]}
          />
        }
        ListEmptyComponent={
          <View style={s.empty}>
            <MaterialIcons name="event-busy" size={72} color={C.borderSub} />
            <Text style={s.emptyTitle}>
              {filter === 'upcoming' ? 'No upcoming events' : 'No events yet'}
            </Text>
            <Text style={s.emptySub}>
              Tap the button below to schedule one!
            </Text>
          </View>
        }
        renderItem={({ item: group }) => (
          <View key={group.date}>
            <View style={s.dateHeader}>
              <Text style={s.dateHeaderText}>{group.displayDate}</Text>
              {group.isToday && (
                <View style={s.todayBadge}>
                  <Text style={s.todayBadgeText}>Today</Text>
                </View>
              )}
            </View>

            {group.events.map((event) => (
              <TouchableOpacity
                key={event.id}
                testID={`event-card-${event.id}`}
                style={s.eventCard}
                activeOpacity={0.7}
                onPress={() => router.push({ pathname: '/event-editor', params: { eventId: event.id } })}
              >
                <View style={s.eventTimeCol}>
                  <Text style={s.timeStart}>{formatEventTime(event.start_time)}</Text>
                  <Text style={s.timeEnd}>{formatEventTime(event.end_time)}</Text>
                </View>

                <View style={s.eventBody}>
                  <Text style={s.eventTitle} numberOfLines={1}>{event.title}</Text>
                  {event.description ? (
                    <Text style={s.eventDesc} numberOfLines={1}>{event.description}</Text>
                  ) : null}
                  {event.reminder_minutes ? (
                    <View style={s.reminderRow}>
                      <MaterialIcons name="notifications" size={14} color={C.primary} />
                      <Text style={s.reminderText}>{formatReminderMinutes(event.reminder_minutes)}</Text>
                    </View>
                  ) : null}
                  {event.recurrence ? (
                    <View style={s.reminderRow}>
                      <MaterialIcons name="repeat" size={14} color={C.secondary} />
                      <Text style={[s.reminderText, { color: C.secondary }]}>{formatRecurrenceSummary(event.recurrence)}</Text>
                    </View>
                  ) : null}
                </View>

                <View style={s.actions}>
                  <TouchableOpacity
                    testID={`delete-event-${event.id}`}
                    style={s.actionBtn}
                    onPress={(e) => {
                      e.stopPropagation();
                      handleDeletePress(event.id, event.title, event.device_calendar_event_id);
                    }}
                  >
                    <MaterialIcons name="delete" size={18} color={C.text} />
                  </TouchableOpacity>
                </View>
              </TouchableOpacity>
            ))}
          </View>
        )}
        ListFooterComponent={<View style={{ height: 100 }} />}
      />

      {/* FAB - Animated */}
      <Animated.View style={[s.fab, { width: fabWidth }]}>
        <TouchableOpacity
          testID="create-event-btn"
          style={s.fabTouchable}
          onPress={() => router.push({ pathname: '/event-editor', params: { date: new Date().toISOString() } })}
          activeOpacity={0.8}
        >
          <View style={s.fabIconContainer}>
            <MaterialIcons name="add" size={32} color={C.primaryFg} />
          </View>
          <Animated.Text style={[s.fabText, { opacity: textOpacity }]}>
            New Event
          </Animated.Text>
        </TouchableOpacity>
      </Animated.View>

      {/* Delete Confirmation Modal */}
      <Modal
        visible={deleteModalVisible}
        transparent={true}
        animationType="fade"
        onRequestClose={cancelDelete}
      >
        <View style={s.modalOverlay}>
          <View style={s.modalContent}>
            <MaterialIcons name="delete" size={48} color={C.error} style={{ marginBottom: 16 }} />
            <Text style={s.modalTitle}>Delete Event?</Text>
            <Text style={s.modalMessage}>
              Are you sure you want to delete "{eventToDelete?.title}"? This action cannot be undone.
            </Text>
            <View style={s.modalButtons}>
              <TouchableOpacity
                style={s.modalCancelBtn}
                onPress={cancelDelete}
                activeOpacity={0.7}
              >
                <Text style={s.modalCancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={s.modalDeleteBtn}
                onPress={confirmDelete}
                activeOpacity={0.7}
                disabled={deleting}
              >
                {deleting ? (
                  <ActivityIndicator size="small" color="#FFFFFF" />
                ) : (
                  <Text style={s.modalDeleteText}>Delete</Text>
                )}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  loadText: { fontSize: 18, color: C.textSec, marginTop: 12 },
  header: { 
    flexDirection: 'row', 
    justifyContent: 'space-between', 
    alignItems: 'center',
    paddingHorizontal: 24, 
    paddingTop: 12, 
    paddingBottom: 12 
  },
  headerTitle: { fontSize: 34, fontWeight: '700', color: C.text },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  headerIconBtn: {
    width: 40, height: 40, borderRadius: 20,
    justifyContent: 'center', alignItems: 'center',
    backgroundColor: C.surface, borderWidth: borderWidth.regular, borderColor: C.border,
  },
  filterRow: { marginHorizontal: 20, marginBottom: 12 },
  scroll: { flex: 1 },
  scrollContent: { paddingHorizontal: 20 },
  empty: { alignItems: 'center', paddingTop: 48 },
  emptyTitle: { fontSize: 22, fontWeight: '600', color: C.text, marginTop: 12 },
  emptySub: { fontSize: 16, color: C.textSec, marginTop: 6, textAlign: 'center', paddingHorizontal: 24 },
  dateHeader: {
    flexDirection: 'row', alignItems: 'center', marginBottom: 6, marginTop: 12,
  },
  dateHeaderText: { fontSize: 14, fontWeight: '500', color: C.textSec },
  todayBadge: {
    marginLeft: 8, backgroundColor: C.success, borderRadius: 10,
    paddingHorizontal: 8, paddingVertical: 2,
  },
  todayBadgeText: { fontSize: 12, fontWeight: '700', color: C.primaryFg },
  eventCard: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: C.surface, borderRadius: radius.md,
    paddingVertical: 10, paddingHorizontal: 12,
    borderWidth: borderWidth.regular, borderColor: C.border, marginBottom: 8,
  },
  eventTimeCol: { marginRight: 12, alignItems: 'flex-start', minWidth: 64 },
  timeStart: { fontSize: 15, fontWeight: '700', color: C.secondary },
  timeEnd: { fontSize: 13, fontWeight: '500', color: C.borderSub, marginTop: 1 },
  eventBody: { flex: 1 },
  eventTitle: { fontSize: 16, fontWeight: '600', color: C.text },
  eventDesc: { fontSize: 13, color: C.textSec, marginTop: 2 },
  reminderRow: { 
    flexDirection: 'row', 
    alignItems: 'center', 
    marginTop: 4,
  },
  reminderText: { 
    fontSize: 12, 
    color: C.primary, 
    fontWeight: '500',
    marginLeft: 4,
  },
  actions: { flexDirection: 'row', gap: 2 },
  actionBtn: {
    width: 36, height: 36, justifyContent: 'center', alignItems: 'center',
    borderRadius: 8,
  },
  fab: {
    // Match the Notes/Calendar FAB position + size so the CTA sits in the same spot on every tab.
    position: 'absolute', bottom: 24, right: 24,
    backgroundColor: C.primary, borderRadius: 36,
    height: 64, overflow: 'hidden',
    elevation: 4,
  },
  fabTouchable: {
    flex: 1, flexDirection: 'row', alignItems: 'center',
  },
  fabIconContainer: {
    width: 64, height: 64,
    justifyContent: 'center', alignItems: 'center',
  },
  fabText: { fontSize: 20, fontWeight: '600', color: C.primaryFg, marginRight: 16 },
  // Modal styles
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  modalContent: {
    backgroundColor: C.surface,
    borderRadius: 20,
    padding: 24,
    width: '100%',
    maxWidth: 340,
    alignItems: 'center',
  },
  modalTitle: {
    fontSize: 22,
    fontWeight: '700',
    color: C.text,
    marginBottom: 12,
  },
  modalMessage: {
    fontSize: 16,
    color: C.textSec,
    textAlign: 'center',
    lineHeight: 24,
    marginBottom: 24,
  },
  modalButtons: {
    flexDirection: 'row',
    gap: 12,
    width: '100%',
  },
  modalCancelBtn: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: 12,
    backgroundColor: '#E0E0E0',
    alignItems: 'center',
  },
  modalCancelText: {
    fontSize: 16,
    fontWeight: '600',
    color: C.text,
  },
  modalDeleteBtn: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: 12,
    backgroundColor: C.error,
    alignItems: 'center',
  },
  modalDeleteText: {
    fontSize: 16,
    fontWeight: '600',
    color: '#FFFFFF',
  },
  // Logout modal styles
  modalLogoutBtn: { flex: 1, paddingVertical: 14, borderRadius: 12, backgroundColor: C.primary, alignItems: 'center' },
  modalLogoutText: { fontSize: 16, fontWeight: '600', color: '#FFFFFF' },
});
