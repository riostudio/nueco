import React, { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, ScrollView,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { MaterialIcons } from '@expo/vector-icons';
import { useRouter, useFocusEffect, type Href } from 'expo-router';
import { useIsFocused } from '@react-navigation/native';
import { getLocalEvents, fullSync } from '../../src/offlineSync';
import { eventsSignature, shouldFocusSync } from '../../src/events/eventsFeed';
import { CalendarEvent } from '../../src/types';
import { C, radius, borderWidth } from '../../src/theme';
import { prefixEmoji } from '../../src/events/eventEmoji';
import { EventCardSkeleton } from '../../src/components/Skeleton';
import { MONTH_NAMES, DAY_NAMES } from '../../src/dateNames';
import { UserAvatar } from '../../src/auth';
import { eventOccursOnDay } from '../../src/recurrence';

function formatEventTime(iso: string): string {
  const d = new Date(iso);
  const h = d.getHours();
  const m = d.getMinutes();
  const ampm = h >= 12 ? 'PM' : 'AM';
  const hour = h % 12 || 12;
  return `${hour}:${m.toString().padStart(2, '0')} ${ampm}`;
}

// The time column shows one line for a point-in-time event (or "All day"), and a start/end
// pair only when they genuinely display differently - previously this always printed both
// start and end unconditionally, which for an all-day event (whose start/end are both
// midnight, just on consecutive dates) meant the same formatted clock time appeared twice.
function formatEventTimeRange(event: CalendarEvent): { primary: string; secondary: string | null } {
  if (event.all_day) return { primary: 'All day', secondary: null };
  const start = formatEventTime(event.start_time);
  const end = formatEventTime(event.end_time);
  return { primary: start, secondary: end !== start ? end : null };
}

// Time-of-day, not raw start_time epoch: every event passed in already occurs on the target
// day (eventOccursOnDay already filtered for that), so for a recurring event start_time's
// *date* is just whenever the series was originally created - comparing full epochs could sort
// a months-old recurring 3pm meeting before today's 9am one-off, even though 9am should render
// first. Only the local hour/minute-of-day is meaningful for ordering within a single day.
function timeOfDayMinutes(iso: string): number {
  const d = new Date(iso);
  return d.getHours() * 60 + d.getMinutes();
}

export default function CalendarScreen() {
  const router = useRouter();
  const isFocused = useIsFocused();
  const [currentDate, setCurrentDate] = useState(new Date());
  const [selectedDate, setSelectedDate] = useState(new Date());
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [loading, setLoading] = useState(true);

  const year = currentDate.getFullYear();
  const month = currentDate.getMonth();

  // Local-first, then reconcile via fullSync - same pattern (tabs)/events.tsx uses. Previously
  // this followed the local-first render with a raw eventsApi.getAllCached() call that had no
  // merge logic at all: it unconditionally overwrote the correct local render with whatever the
  // (possibly stale-cached, possibly not-yet-caught-up) server response was, so a just-created
  // event could flash into view and then vanish again if its push hadn't landed yet. Routing
  // through fullSync + re-reading the local store (like events.tsx already does) means both tabs
  // now go through the exact same reconciliation path and can't disagree with each other.
  // Signature-gated so an unchanged list doesn't re-render. getLocalEvents returns a fresh array
  // every call, so setEvents always saw a new reference and rebuilt the whole grid on every focus.
  const sigRef = useRef('');
  const applyEvents = useCallback((list: Awaited<ReturnType<typeof getLocalEvents>>) => {
    const next = list.filter(e => !e._pendingDelete) as CalendarEvent[];
    const sig = eventsSignature(next);
    if (sig === sigRef.current) return;
    sigRef.current = sig;
    setEvents(next);
  }, []);

  const loadEvents = useCallback(async (force?: boolean) => {
    try {
      applyEvents(await getLocalEvents());
      // Throttled across both event screens - see eventsFeed.ts. Pull-to-refresh passes force.
      if (!shouldFocusSync(force)) return;
      await fullSync({ force });
      applyEvents(await getLocalEvents());
    } catch (e) {
      console.error('Failed to load events:', e);
    } finally {
      setLoading(false);
    }
  }, [applyEvents]);

  useFocusEffect(useCallback(() => { loadEvents(); }, [loadEvents]));

  // Polling for sync across devices - check for updates every 30 seconds, only while this tab
  // is actually the one visible (see (tabs)/events.tsx for why - all three tabs stay mounted).
  useEffect(() => {
    const pollInterval = setInterval(() => {
      if (!loading && isFocused) {
        loadEvents();
      }
    }, 30000); // 30 seconds

    return () => clearInterval(pollInterval);
  }, [loadEvents, loading, isFocused]);

  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  const days: (number | null)[] = [];
  for (let i = 0; i < firstDay; i++) days.push(null);
  for (let d = 1; d <= daysInMonth; d++) days.push(d);
  while (days.length % 7 !== 0) days.push(null);

  const selDay = selectedDate.getDate();
  const selMonth = selectedDate.getMonth();
  const selYear = selectedDate.getFullYear();

  // Precomputes which days have an event once per [events, year, month] change instead of
  // rescanning the full events array (via eventOccursOnDay, which for recurring events does a
  // bounded day-stepping search) once per grid cell on every render - including renders
  // triggered by unrelated state changes like selecting a day or the 30s sync poll ticking
  // with no actual event changes.
  const daysWithEvents = useMemo(() => {
    const set = new Set<number>();
    for (let day = 1; day <= daysInMonth; day++) {
      if (events.some((e) => eventOccursOnDay(e, year, month, day))) {
        set.add(day);
      }
    }
    return set;
  }, [events, year, month, daysInMonth]);
  const hasEvents = (day: number) => daysWithEvents.has(day);

  const today = new Date();
  const isToday = (day: number) =>
    day === today.getDate() && month === today.getMonth() && year === today.getFullYear();
  const isSelected = (day: number) =>
    day === selDay && month === selMonth && year === selYear;

  const prevMonth = () => setCurrentDate(new Date(year, month - 1, 1));
  const nextMonth = () => setCurrentDate(new Date(year, month + 1, 1));
  const selectDay = (day: number) => setSelectedDate(new Date(year, month, day));

  const selectedDayEvents = useMemo(
    () =>
      events
        .filter((e) => eventOccursOnDay(e, selYear, selMonth, selDay))
        .sort((a, b) => timeOfDayMinutes(a.start_time) - timeOfDayMinutes(b.start_time)),
    [events, selYear, selMonth, selDay]
  );

  const rows: (number | null)[][] = [];
  for (let i = 0; i < days.length; i += 7) {
    rows.push(days.slice(i, i + 7));
  }

  return (
    <SafeAreaView style={s.container} edges={['top']}>
      <View style={s.header}>
        <Text style={s.headerTitle}>Calendar</Text>
        <UserAvatar size={36} />
      </View>

      {/* Month Navigation */}
      <View style={s.monthNav}>
        <TouchableOpacity testID="prev-month-btn" style={s.navBtn} onPress={prevMonth}>
          <MaterialIcons name="chevron-left" size={36} color={C.text} />
        </TouchableOpacity>
        <Text style={s.monthText}>{MONTH_NAMES[month]} {year}</Text>
        <TouchableOpacity testID="next-month-btn" style={s.navBtn} onPress={nextMonth}>
          <MaterialIcons name="chevron-right" size={36} color={C.text} />
        </TouchableOpacity>
      </View>

      <ScrollView contentContainerStyle={s.scrollContent} showsVerticalScrollIndicator={false}>
        {/* Day Names */}
        <View style={s.dayNamesRow}>
          {DAY_NAMES.map((d, i) => (
            <Text key={i} style={s.dayName}>{d}</Text>
          ))}
        </View>

        {/* Calendar Grid - always rendered instantly (the grid is derived from the date); event
            day-markers fill in when events load, instead of replacing the whole grid with a spinner. */}
        <View style={s.grid}>
          {rows.map((row, ri) => (
            <View key={ri} style={s.gridRow}>
              {row.map((day, ci) => (
                <TouchableOpacity
                  key={ci}
                  testID={day ? `cal-day-${day}` : `cal-empty-${ri}-${ci}`}
                  style={[
                    s.dayCell,
                    day && isSelected(day) ? s.selectedDay : null,
                    day && isToday(day) && !isSelected(day) ? s.todayDay : null,
                  ]}
                  onPress={() => day && selectDay(day)}
                  disabled={!day}
                  activeOpacity={0.6}
                >
                  {day ? (
                    <>
                      <Text
                        style={[
                          s.dayText,
                          day && isSelected(day) ? s.selectedDayText : null,
                          day && isToday(day) && !isSelected(day) ? s.todayText : null,
                        ]}
                      >
                        {day}
                      </Text>
                      {hasEvents(day) && (
                        <View style={[s.dot, isSelected(day) && s.dotSelected]} />
                      )}
                    </>
                  ) : null}
                </TouchableOpacity>
              ))}
            </View>
          ))}
        </View>

        {/* Selected Day - date header plus the actual events on it, not just a count. */}
        <View style={s.selectedDateHeader}>
          <Text style={s.selectedDate}>
            {MONTH_NAMES[selMonth]} {selDay}, {selYear}
          </Text>
        </View>

        {loading && events.length === 0 ? (
          // First load with nothing cached: hold the list's shape rather than flashing
          // "No events on this day" and then replacing it a moment later, which reads as the
          // app having got it wrong.
          <><EventCardSkeleton /><EventCardSkeleton /></>
        ) : selectedDayEvents.length > 0 ? (
          selectedDayEvents.map((event) => {
            const { primary, secondary } = formatEventTimeRange(event);
            return (
            <TouchableOpacity
              key={event.id}
              testID={`cal-selected-event-${event.id}`}
              style={s.eventCard}
              activeOpacity={0.7}
              onPress={() => router.push(`/event?eventId=${event.id}` as Href)}
            >
              <View style={s.eventTimeCol}>
                <Text style={s.timeStart}>{primary}</Text>
                {secondary ? <Text style={s.timeEnd}>{secondary}</Text> : null}
              </View>
              <View style={s.eventBody}>
                <Text style={s.eventTitle} numberOfLines={1}>{prefixEmoji(event.title)}</Text>
                {event.location ? (
                  <Text style={s.eventDesc} numberOfLines={1}>{event.location}</Text>
                ) : null}
              </View>
              <MaterialIcons name="chevron-right" size={22} color={C.textSec} />
            </TouchableOpacity>
            );
          })
        ) : (
          <Text style={s.emptyHint}>No events on this day</Text>
        )}
      </ScrollView>

      {/* FAB */}
      <TouchableOpacity
        testID="create-event-btn"
        style={s.fab}
        onPress={() =>
          router.push({
            pathname: '/event-editor',
            params: { date: selectedDate.toISOString() },
          })
        }
        activeOpacity={0.8}
      >
        <MaterialIcons name="add" size={32} color={C.primaryFg} />
        <Text style={s.fabText}>New event</Text>
      </TouchableOpacity>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 24,
    paddingTop: 12,
    paddingBottom: 12
  },
  headerTitle: { fontSize: 34, fontWeight: '700', color: C.text },
  monthNav: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 24, paddingVertical: 8,
  },
  navBtn: { width: 56, height: 56, justifyContent: 'center', alignItems: 'center' },
  monthText: { fontSize: 24, fontWeight: '600', color: C.text },
  dayNamesRow: { flexDirection: 'row', paddingHorizontal: 12, marginBottom: 4 },
  dayName: {
    flex: 1, textAlign: 'center', fontSize: 16, fontWeight: '600',
    color: C.textSec, paddingVertical: 4,
  },
  loadingGrid: { height: 240, justifyContent: 'center', alignItems: 'center' },
  grid: { paddingHorizontal: 12 },
  gridRow: { flexDirection: 'row' },
  dayCell: {
    // Original was aspectRatio: 1 (square). 1 / 0.75 = 1.33 makes each cell 25% shorter for the
    // same width - the one deliberate, precisely-sized change from the original layout.
    flex: 1, aspectRatio: 1.33, justifyContent: 'center', alignItems: 'center',
    margin: 2, borderRadius: 12,
  },
  selectedDay: { backgroundColor: C.primary },
  todayDay: { backgroundColor: C.surfaceHi, borderWidth: borderWidth.thick, borderColor: C.primary },
  dayText: { fontSize: 18, fontWeight: '500', color: C.text },
  selectedDayText: { color: C.primaryFg, fontWeight: '700' },
  todayText: { color: C.primary, fontWeight: '700' },
  dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: C.primary, marginTop: 2 },
  dotSelected: { backgroundColor: C.primaryFg },
  scrollContent: { paddingBottom: 100 },
  selectedDateHeader: { marginHorizontal: 24, marginTop: 20, marginBottom: 10 },
  selectedDate: { fontSize: 22, fontWeight: '600', color: C.text },
  eventCard: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: C.surface, borderRadius: radius.md,
    paddingVertical: 12, paddingHorizontal: 16,
    marginHorizontal: 24, marginBottom: 10,
    // Border removed by request. Surface (#FFFFFF) and page (#FDFBF7) are close enough that a
    // borderless card would nearly dissolve into the background, so a very soft shadow keeps the
    // edge readable without reintroducing a visible grey line.
    shadowColor: '#0A5443', shadowOpacity: 0.06, shadowRadius: 6, shadowOffset: { width: 0, height: 2 },
    elevation: 1,
  },
  eventTimeCol: { marginRight: 14, alignItems: 'flex-start', minWidth: 64 },
  timeStart: { fontSize: 15, fontWeight: '700', color: C.secondary },
  timeEnd: { fontSize: 13, fontWeight: '500', color: C.borderSub, marginTop: 1 },
  eventBody: { flex: 1 },
  eventTitle: { fontSize: 16, fontWeight: '600', color: C.text },
  eventDesc: { fontSize: 13, color: C.textSec, marginTop: 2 },
  emptyHint: {
    fontSize: 15, color: C.textSec, textAlign: 'center', marginTop: 8, marginHorizontal: 24,
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
