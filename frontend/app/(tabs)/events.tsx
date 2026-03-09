import React, { useState, useCallback, useRef } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, ScrollView,
  RefreshControl, ActivityIndicator, Alert, Animated,
  NativeSyntheticEvent, NativeScrollEvent,
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
  const [fabExpanded, setFabExpanded] = useState(false);
  const fabWidth = useRef(new Animated.Value(56)).current;
  const textOpacity = useRef(new Animated.Value(0)).current;
  const lastScrollY = useRef(0);

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

  const expandFab = () => {
    if (fabExpanded) return;
    setFabExpanded(true);
    Animated.parallel([
      Animated.spring(fabWidth, { toValue: 160, useNativeDriver: false, friction: 8 }),
      Animated.timing(textOpacity, { toValue: 1, duration: 200, useNativeDriver: false }),
    ]).start();
  };

  const collapseFab = () => {
    if (!fabExpanded) return;
    setFabExpanded(false);
    Animated.parallel([
      Animated.spring(fabWidth, { toValue: 56, useNativeDriver: false, friction: 8 }),
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
        onScroll={handleScroll}
        scrollEventThrottle={16}
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
                  <View style={s.eventTimeCol}>
                    <Text style={s.timeStart}>{formatEventTime(event.start_time)}</Text>
                    <Text style={s.timeEnd}>{formatEventTime(event.end_time)}</Text>
                  </View>

                  <View style={s.eventBody}>
                    <Text style={s.eventTitle} numberOfLines={1}>{event.title}</Text>
                    {event.description ? (
                      <Text style={s.eventDesc} numberOfLines={1}>{event.description}</Text>
                    ) : null}
                  </View>

                  <View style={s.actions}>
                    <TouchableOpacity
                      testID={`edit-event-${event.id}`}
                      style={s.actionBtn}
                      onPress={() => router.push({ pathname: '/event-editor', params: { eventId: event.id } })}
                    >
                      <MaterialIcons name="edit" size={20} color={C.secondary} />
                    </TouchableOpacity>
                    <TouchableOpacity
                      testID={`delete-event-${event.id}`}
                      style={s.actionBtn}
                      onPress={() => handleDelete(event.id, event.title)}
                    >
                      <MaterialIcons name="delete" size={20} color={C.error} />
                    </TouchableOpacity>
                  </View>
                </View>
              ))}
            </View>
          ))
        )}
        <View style={{ height: 100 }} />
      </ScrollView>

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
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  loadText: { fontSize: 18, color: C.textSec, marginTop: 12 },
  header: { paddingHorizontal: 20, paddingTop: 8, paddingBottom: 4 },
  headerTitle: { fontSize: 28, fontWeight: '700', color: C.text },
  filterRow: {
    flexDirection: 'row', marginHorizontal: 20, marginBottom: 12,
    backgroundColor: C.surface, borderRadius: 10,
    borderWidth: 2, borderColor: C.border, overflow: 'hidden',
  },
  filterBtn: {
    flex: 1, paddingVertical: 10, alignItems: 'center', justifyContent: 'center',
  },
  filterBtnActive: { backgroundColor: C.primary },
  filterText: { fontSize: 16, fontWeight: '600', color: C.textSec },
  filterTextActive: { color: C.primaryFg },
  scroll: { flex: 1 },
  scrollContent: { paddingHorizontal: 20 },
  empty: { alignItems: 'center', paddingTop: 48 },
  emptyTitle: { fontSize: 22, fontWeight: '600', color: C.text, marginTop: 12 },
  emptySub: { fontSize: 16, color: C.textSec, marginTop: 6, textAlign: 'center', paddingHorizontal: 24 },
  dateHeader: {
    flexDirection: 'row', alignItems: 'center', marginBottom: 6, marginTop: 12,
  },
  dateHeaderText: { fontSize: 16, fontWeight: '700', color: C.text },
  todayBadge: {
    marginLeft: 8, backgroundColor: C.success, borderRadius: 10,
    paddingHorizontal: 8, paddingVertical: 2,
  },
  todayBadgeText: { fontSize: 12, fontWeight: '700', color: C.primaryFg },
  eventCard: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: C.surface, borderRadius: 10, 
    paddingVertical: 10, paddingHorizontal: 12,
    borderWidth: 1.5, borderColor: C.borderSub, marginBottom: 8,
  },
  eventTimeCol: { marginRight: 12, alignItems: 'flex-end', minWidth: 58 },
  timeStart: { fontSize: 13, fontWeight: '700', color: C.secondary },
  timeEnd: { fontSize: 12, fontWeight: '500', color: C.borderSub, marginTop: 1 },
  eventBody: { flex: 1 },
  eventTitle: { fontSize: 16, fontWeight: '600', color: C.text },
  eventDesc: { fontSize: 13, color: C.textSec, marginTop: 2 },
  actions: { flexDirection: 'row', gap: 2 },
  actionBtn: {
    width: 36, height: 36, justifyContent: 'center', alignItems: 'center',
    borderRadius: 8,
  },
  fab: {
    position: 'absolute', bottom: 20, right: 20,
    backgroundColor: C.primary, borderRadius: 28,
    height: 56, overflow: 'hidden',
    elevation: 4,
  },
  fabTouchable: {
    flex: 1, flexDirection: 'row', alignItems: 'center',
  },
  fabIconContainer: {
    width: 56, height: 56, 
    justifyContent: 'center', alignItems: 'center',
  },
  fabText: { fontSize: 16, fontWeight: '600', color: C.primaryFg, marginRight: 16 },
});
