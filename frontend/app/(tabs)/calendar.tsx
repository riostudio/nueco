import React, { useState, useCallback, useEffect } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { MaterialIcons } from '@expo/vector-icons';
import { useRouter, useFocusEffect } from 'expo-router';
import { eventsApi } from '../../src/api';
import { decryptEventsFromServer } from '../../src/crypto/eventCrypto';
import { CalendarEvent } from '../../src/types';
import { MONTH_NAMES, DAY_NAMES, C, radius, borderWidth } from '../../src/theme';
import { UserAvatar } from '../../src/auth';

export default function CalendarScreen() {
  const router = useRouter();
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

  const hasEvents = (day: number) =>
    events.some((e) => eventCoversDay(e, year, month, day));

  const today = new Date();
  const isToday = (day: number) =>
    day === today.getDate() && month === today.getMonth() && year === today.getFullYear();
  const isSelected = (day: number) =>
    day === selDay && month === selMonth && year === selYear;

  const prevMonth = () => setCurrentDate(new Date(year, month - 1, 1));
  const nextMonth = () => setCurrentDate(new Date(year, month + 1, 1));
  const selectDay = (day: number) => setSelectedDate(new Date(year, month, day));

  // Count events for selected day
  const selectedDayEvents = events.filter((e) => {
    return eventCoversDay(e, selYear, selMonth, selDay);
  });

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

      {/* Day Names */}
      <View style={s.dayNamesRow}>
        {DAY_NAMES.map((d, i) => (
          <Text key={i} style={s.dayName}>{d}</Text>
        ))}
      </View>

      {/* Calendar Grid - always rendered instantly (the grid is derived from the date); event
          day-markers fill in when events load, instead of replacing the whole grid with a spinner. */}
      {(
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
      )}

      {/* Selected Day Info - only show when events exist */}
      {selectedDayEvents.length > 0 && (
        <>
          <TouchableOpacity
            testID="view-events-btn"
            style={s.selectedInfo}
            onPress={() => router.navigate('/(tabs)/events')}
            activeOpacity={0.7}
          >
            <Text style={s.selectedDate}>
              {MONTH_NAMES[selMonth]} {selDay}, {selYear}
            </Text>
            <View style={s.selectedBadge}>
              <MaterialIcons name="event" size={18} color={C.primaryFg} />
              <Text style={s.badgeText}>
                {selectedDayEvents.length} {selectedDayEvents.length === 1 ? 'event' : 'events'}
              </Text>
            </View>
          </TouchableOpacity>
        </>
      )}

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
    flex: 1, aspectRatio: 1, justifyContent: 'center', alignItems: 'center',
    margin: 2, borderRadius: 12,
  },
  selectedDay: { backgroundColor: C.primary },
  todayDay: { backgroundColor: C.surfaceHi, borderWidth: borderWidth.thick, borderColor: C.primary },
  dayText: { fontSize: 18, fontWeight: '500', color: C.text },
  selectedDayText: { color: C.primaryFg, fontWeight: '700' },
  todayText: { color: C.primary, fontWeight: '700' },
  dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: C.primary, marginTop: 2 },
  dotSelected: { backgroundColor: C.primaryFg },
  selectedInfo: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    marginHorizontal: 24, marginTop: 20,
    backgroundColor: C.surface, borderRadius: radius.md,
    borderWidth: borderWidth.regular, borderColor: C.border, padding: 16,
  },
  selectedDate: { fontSize: 22, fontWeight: '600', color: C.text },
  selectedBadge: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: C.primary, borderRadius: 20,
    paddingHorizontal: 14, paddingVertical: 6,
  },
  badgeText: { fontSize: 16, fontWeight: '600', color: C.primaryFg, marginLeft: 6 },
  hint: {
    fontSize: 16, color: C.primary, textAlign: 'center',
    marginTop: 12, fontWeight: '500', textDecorationLine: 'underline',
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
