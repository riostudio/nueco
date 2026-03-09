import React, { useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, ScrollView,
  RefreshControl, ActivityIndicator, Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { MaterialIcons } from '@expo/vector-icons';
import { useRouter, useFocusEffect } from 'expo-router';
import { eventsApi } from '../../src/api';
import { CalendarEvent } from '../../src/types';
import { MONTH_NAMES } from '../../src/theme';

const C = {
  primary: '#D84315',
  primaryFg: '#FFFFFF',
  secondary: '#1565C0',
  bg: '#FDFBF7',
  surface: '#FFFFFF',
  text: '#121212',
  textSec: '#37474F',
  border: '#121212',
  borderSub: '#78909C',
  error: '#C62828',
  success: '#2E7D32',
};

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
  return `${MONTH_NAMES[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

function isEventToday(iso: string): boolean {
  const d = new Date(iso);
  const now = new Date();
  return d.getDate() === now.getDate() &&
    d.getMonth() === now.getMonth() &&
    d.getFullYear() === now.getFullYear();
}

function isEventUpcoming(iso: string): boolean {
  return new Date(iso) >= new Date(new Date().setHours(0, 0, 0, 0));
}

type GroupedEvents = { date: string; displayDate: string; isToday: boolean; events: CalendarEvent[] }[];

function groupEventsByDate(events: CalendarEvent[]): GroupedEvents {
  const map = new Map<string, { displayDate: string; isToday: boolean; events: CalendarEvent[] }>();

  for (const evt of events) {
    const dateKey = evt.start_time.substring(0, 10);
    if (!map.has(dateKey)) {
      map.set(dateKey, {
        displayDate: formatEventDate(evt.start_time),
        isToday: isEventToday(evt.start_time),
        events: [],
      });
    }
    map.get(dateKey)!.events.push(evt);
  }

  return Array.from(map.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, val]) => ({ date, ...val }));
}

export default function EventsScreen() {
  const router = useRouter();
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [filter, setFilter] = useState<'upcoming' | 'all'>('upcoming');

  const loadEvents = useCallback(async () => {
    try {
      const data = await eventsApi.getAll();
      setEvents(data);
    } catch (e) {
      console.error('Failed to load events:', e);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useFocusEffect(useCallback(() => { loadEvents(); }, [loadEvents]));

  const handleDelete = (eventId: string, eventTitle: string) => {
    Alert.alert(
      'Delete Event',
      `Delete "${eventTitle}"?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            try {
              await eventsApi.delete(eventId);
              loadEvents();
            } catch (e) {
              console.error('Delete failed:', e);
            }
          },
        },
      ]
    );
  };

  const filteredEvents = filter === 'upcoming'
    ? events.filter((e) => isEventUpcoming(e.start_time))
    : events;

  const grouped = groupEventsByDate(filteredEvents);

  if (loading) {
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
      </View>

      {/* Filter Toggle */}
      <View style={s.filterRow}>
        <TouchableOpacity
          testID="filter-upcoming-btn"
          style={[s.filterBtn, filter === 'upcoming' && s.filterBtnActive]}
          onPress={() => setFilter('upcoming')}
        >
          <Text style={[s.filterText, filter === 'upcoming' && s.filterTextActive]}>
            Upcoming
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          testID="filter-all-btn"
          style={[s.filterBtn, filter === 'all' && s.filterBtnActive]}
          onPress={() => setFilter('all')}
        >
          <Text style={[s.filterText, filter === 'all' && s.filterTextActive]}>
            All Events
          </Text>
        </TouchableOpacity>
      </View>

      <ScrollView
        style={s.scroll}
        contentContainerStyle={s.scrollContent}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => { setRefreshing(true); loadEvents(); }}
            colors={[C.primary]}
          />
        }
      >
        {grouped.length === 0 ? (
          <View style={s.empty}>
            <MaterialIcons name="event-busy" size={72} color={C.borderSub} />
            <Text style={s.emptyTitle}>
              {filter === 'upcoming' ? 'No upcoming events' : 'No events yet'}
            </Text>
            <Text style={s.emptySub}>
              Tap the button below to schedule one!
            </Text>
          </View>
        ) : (
          grouped.map((group) => (
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
                <View key={event.id} testID={`event-card-${event.id}`} style={s.eventCard}>
                  <View style={s.timeLine}>
                    <Text style={s.timeStart}>{formatEventTime(event.start_time)}</Text>
                    <View style={s.timeDivider} />
                    <Text style={s.timeEnd}>{formatEventTime(event.end_time)}</Text>
                  </View>

                  <View style={s.eventBody}>
                    <Text style={s.eventTitle}>{event.title}</Text>
                    {event.description ? (
                      <Text style={s.eventDesc} numberOfLines={2}>{event.description}</Text>
                    ) : null}
                    {event.linked_note_ids.length > 0 && (
                      <View style={s.linkedRow}>
                        <MaterialIcons name="link" size={14} color={C.secondary} />
                        <Text style={s.linkedText}>
                          {event.linked_note_ids.length} linked {event.linked_note_ids.length === 1 ? 'note' : 'notes'}
                        </Text>
                      </View>
                    )}
                  </View>

                  <View style={s.actions}>
                    <TouchableOpacity
                      testID={`edit-event-${event.id}`}
                      style={s.actionBtn}
                      onPress={() => router.push({ pathname: '/event-editor', params: { eventId: event.id } })}
                    >
                      <MaterialIcons name="edit" size={22} color={C.secondary} />
                    </TouchableOpacity>
                    <TouchableOpacity
                      testID={`delete-event-${event.id}`}
                      style={s.actionBtn}
                      onPress={() => handleDelete(event.id, event.title)}
                    >
                      <MaterialIcons name="delete" size={22} color={C.error} />
                    </TouchableOpacity>
                  </View>
                </View>
              ))}
            </View>
          ))
        )}
        <View style={{ height: 100 }} />
      </ScrollView>

      {/* FAB */}
      <TouchableOpacity
        testID="create-event-btn"
        style={s.fab}
        onPress={() => router.push({ pathname: '/event-editor', params: { date: new Date().toISOString() } })}
        activeOpacity={0.8}
      >
        <MaterialIcons name="add" size={32} color={C.primaryFg} />
        <Text style={s.fabText}>New Event</Text>
      </TouchableOpacity>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  loadText: { fontSize: 20, color: C.textSec, marginTop: 16 },
  header: { paddingHorizontal: 24, paddingTop: 12, paddingBottom: 8 },
  headerTitle: { fontSize: 34, fontWeight: '700', color: C.text },
  filterRow: {
    flexDirection: 'row', marginHorizontal: 24, marginBottom: 16,
    backgroundColor: C.surface, borderRadius: 12,
    borderWidth: 2, borderColor: C.border, overflow: 'hidden',
  },
  filterBtn: {
    flex: 1, paddingVertical: 12, alignItems: 'center', justifyContent: 'center',
  },
  filterBtnActive: { backgroundColor: C.primary },
  filterText: { fontSize: 18, fontWeight: '600', color: C.textSec },
  filterTextActive: { color: C.primaryFg },
  scroll: { flex: 1 },
  scrollContent: { paddingHorizontal: 24 },
  empty: { alignItems: 'center', paddingTop: 60 },
  emptyTitle: { fontSize: 24, fontWeight: '600', color: C.text, marginTop: 16 },
  emptySub: { fontSize: 18, color: C.textSec, marginTop: 8, textAlign: 'center', paddingHorizontal: 32 },
  dateHeader: {
    flexDirection: 'row', alignItems: 'center', marginBottom: 10, marginTop: 16,
  },
  dateHeaderText: { fontSize: 20, fontWeight: '700', color: C.text },
  todayBadge: {
    marginLeft: 10, backgroundColor: C.success, borderRadius: 12,
    paddingHorizontal: 10, paddingVertical: 3,
  },
  todayBadgeText: { fontSize: 14, fontWeight: '700', color: C.primaryFg },
  eventCard: {
    flexDirection: 'row', alignItems: 'flex-start',
    backgroundColor: C.surface, borderRadius: 12, padding: 16,
    borderWidth: 2, borderColor: C.borderSub, marginBottom: 12,
  },
  timeLine: { marginRight: 16, alignItems: 'center', minWidth: 65 },
  timeStart: { fontSize: 15, fontWeight: '700', color: C.secondary },
  timeDivider: { width: 2, height: 12, backgroundColor: C.borderSub, marginVertical: 2 },
  timeEnd: { fontSize: 15, fontWeight: '600', color: C.borderSub },
  eventBody: { flex: 1 },
  eventTitle: { fontSize: 20, fontWeight: '600', color: C.text },
  eventDesc: { fontSize: 16, color: C.textSec, marginTop: 4, lineHeight: 22 },
  linkedRow: { flexDirection: 'row', alignItems: 'center', marginTop: 6 },
  linkedText: { fontSize: 14, color: C.secondary, marginLeft: 4 },
  actions: { flexDirection: 'column', gap: 4 },
  actionBtn: {
    width: 44, height: 44, justifyContent: 'center', alignItems: 'center',
    borderRadius: 8,
  },
  fab: {
    position: 'absolute', bottom: 24, right: 24,
    backgroundColor: C.primary, borderRadius: 36,
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 24, height: 64,
    elevation: 4,
  },
  fabText: { fontSize: 20, fontWeight: '600', color: C.primaryFg, marginLeft: 8 },
});
