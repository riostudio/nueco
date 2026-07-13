import React, { useState, useCallback, useEffect } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, ScrollView, useWindowDimensions,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { MaterialIcons } from '@expo/vector-icons';
import { useRouter, useFocusEffect } from 'expo-router';
import { eventsApi } from '../../src/api';
import { decryptEventsFromServer } from '../../src/crypto/eventCrypto';
import { CalendarEvent } from '../../src/types';
import { MONTH_NAMES, DAY_NAMES, C, radius, borderWidth } from '../../src/theme';
import { UserAvatar } from '../../src/auth';
import { occursOnDay } from '../../src/recurrence';

function formatEventTime(iso: string): string {
  const d = new Date(iso);
  const h = d.getHours();
  const m = d.getMinutes();
  const ampm = h >= 12 ? 'PM' : 'AM';
  const hour = h % 12 || 12;
  return `${hour}:${m.toString().padStart(2, '0')} ${ampm}`;
}

export default function CalendarScreen() {
  const router = useRouter();
  const { height: windowHeight } = useWindowDimensions();
  // Grid gets a guaranteed floor of half the screen height, regardless of how many rows this
  // month needs (5 vs 6) - rows below stretch to fill it evenly (see gridRow's flex:1), so the
  // month view stays visually substantial even after the spacing tightening passes.
  const gridMinHeight = windowHeight * 0.5;
  const [currentDate, setCurrentDate] = useState(new Date());
  const [selectedDate, setSelectedDate] = useState(new Date());
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [loading, setLoading] = useState(true);

  const year = currentDate.getFullYear();
  const month = currentDate.getMonth();

  const loadEvents = useCallback(async () => {
    try {
      setLoading(true);
      const data = await decryptEventsFromServer<CalendarEvent>(await eventsApi.getAll(month + 1, year));
      setEvents(data);
    } catch (e) {
      console.error('Failed to load events:', e);
    } finally {
      setLoading(false);
    }
  }, [month, year]);

  useFocusEffect(useCallback(() => { loadEvents(); }, [loadEvents]));

  // Polling for sync across devices - check for updates every 30 seconds
  useEffect(() => {
    const pollInterval = setInterval(() => {
      if (!loading) {
        loadEvents();
      }
    }, 30000); // 30 seconds

    return () => clearInterval(pollInterval);
  }, [loadEvents, loading]);

  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  const days: (number | null)[] = [];
  for (let i = 0; i < firstDay; i++) days.push(null);
  for (let d = 1; d <= daysInMonth; d++) days.push(d);
  while (days.length % 7 !== 0) days.push(null);

  const selDay = selectedDate.getDate();
  const selMonth = selectedDate.getMonth();
  const selYear = selectedDate.getFullYear();

  // Matches any day the event spans, not just its start day - multi-day events (event-editor's
  // End Date field) would otherwise vanish from every day but the first.
  const eventCoversDay = (e: CalendarEvent, y: number, m: number, d: number) => {
    const dayStart = new Date(y, m, d, 0, 0, 0, 0);
    const dayEnd = new Date(y, m, d, 23, 59, 59, 999);
    return new Date(e.start_time) <= dayEnd && new Date(e.end_time) >= dayStart;
  };

  // Recurring events use the display-only occursOnDay helper (day-granularity, not the
  // source of truth for reminder firing) instead of the plain start/end range check -
  // eventCoversDay is left untouched for non-recurring events so their day-matching
  // behavior stays byte-identical to before.
  const eventOccursOnDay = (e: CalendarEvent, y: number, m: number, d: number) =>
    e.recurrence ? occursOnDay(e, y, m, d) : eventCoversDay(e, y, m, d);

  const hasEvents = (day: number) =>
    events.some((e) => eventOccursOnDay(e, year, month, day));

  const today = new Date();
  const isToday = (day: number) =>
    day === today.getDate() && month === today.getMonth() && year === today.getFullYear();
  const isSelected = (day: number) =>
    day === selDay && month === selMonth && year === selYear;

  const prevMonth = () => setCurrentDate(new Date(year, month - 1, 1));
  const nextMonth = () => setCurrentDate(new Date(year, month + 1, 1));
  const selectDay = (day: number) => setSelectedDate(new Date(year, month, day));

  const selectedDayEvents = events
    .filter((e) => eventOccursOnDay(e, selYear, selMonth, selDay))
    .sort((a, b) => new Date(a.start_time).getTime() - new Date(b.start_time).getTime());

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
        <View style={[s.grid, { minHeight: gridMinHeight }]}>
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

        {selectedDayEvents.length > 0 ? (
          selectedDayEvents.map((event) => (
            <TouchableOpacity
              key={event.id}
              testID={`cal-selected-event-${event.id}`}
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
                {event.location ? (
                  <Text style={s.eventDesc} numberOfLines={1}>{event.location}</Text>
                ) : null}
              </View>
              <MaterialIcons name="chevron-right" size={22} color={C.textSec} />
            </TouchableOpacity>
          ))
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
        <Text style={s.fabText}>New Event</Text>
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
    paddingTop: 8,
    paddingBottom: 8
  },
  headerTitle: { fontSize: 34, fontWeight: '700', color: C.text },
  monthNav: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 24, paddingVertical: 2,
  },
  navBtn: { width: 44, height: 44, justifyContent: 'center', alignItems: 'center' },
  monthText: { fontSize: 24, fontWeight: '600', color: C.text },
  dayNamesRow: { flexDirection: 'row', paddingHorizontal: 12, marginBottom: 2 },
  dayName: {
    flex: 1, textAlign: 'center', fontSize: 16, fontWeight: '600',
    color: C.textSec, paddingVertical: 1,
  },
  loadingGrid: { height: 240, justifyContent: 'center', alignItems: 'center' },
  // paddingHorizontal only - vertical size now comes from `gridMinHeight` (inline style, 50% of
  // screen height) via flexDirection: 'column', with each row (flex:1 below) stretching to fill
  // it evenly regardless of whether the month has 5 or 6 rows.
  grid: { paddingHorizontal: 12, flexDirection: 'column' },
  gridRow: { flex: 1, flexDirection: 'row' },
  dayCell: {
    // Height comes from the row's flex share of `gridMinHeight`, not aspectRatio - the grid's
    // total height is now a floor (50% of screen), so a fixed ratio would fight that instead of
    // filling it. Cells stay a comfortable touch target on typical phone widths regardless.
    flex: 1, justifyContent: 'center', alignItems: 'center',
    margin: 1, borderRadius: 12,
  },
  selectedDay: { backgroundColor: C.primary },
  todayDay: { backgroundColor: C.surfaceHi, borderWidth: borderWidth.thick, borderColor: C.primary },
  dayText: { fontSize: 18, fontWeight: '500', color: C.text },
  selectedDayText: { color: C.primaryFg, fontWeight: '700' },
  todayText: { color: C.primary, fontWeight: '700' },
  dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: C.primary, marginTop: 2 },
  dotSelected: { backgroundColor: C.primaryFg },
  scrollContent: { paddingBottom: 100 },
  selectedDateHeader: { marginHorizontal: 24, marginTop: 8, marginBottom: 4 },
  selectedDate: { fontSize: 22, fontWeight: '600', color: C.text },
  eventCard: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: C.surface, borderRadius: radius.md,
    paddingVertical: 10, paddingHorizontal: 16,
    borderWidth: borderWidth.regular, borderColor: C.border,
    marginHorizontal: 24, marginBottom: 8,
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
