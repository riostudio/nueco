import React, { useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, ScrollView,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { MaterialIcons } from '@expo/vector-icons';
import { useRouter, useFocusEffect } from 'expo-router';
import { eventsApi } from '../../src/api';
import { CalendarEvent } from '../../src/types';
import { MONTH_NAMES, DAY_NAMES } from '../../src/theme';

const C = {
  primary: '#D84315',
  primaryFg: '#FFFFFF',
  secondary: '#1565C0',
  bg: '#FDFBF7',
  surface: '#FFFFFF',
  surfaceHi: '#FFF8E1',
  text: '#121212',
  textSec: '#37474F',
  border: '#121212',
  borderSub: '#78909C',
  error: '#C62828',
};

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
  const [currentDate, setCurrentDate] = useState(new Date());
  const [selectedDate, setSelectedDate] = useState(new Date());
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [loading, setLoading] = useState(true);

  const year = currentDate.getFullYear();
  const month = currentDate.getMonth();

  const loadEvents = useCallback(async () => {
    try {
      setLoading(true);
      const data = await eventsApi.getAll(month + 1, year);
      setEvents(data);
    } catch (e) {
      console.error('Failed to load events:', e);
    } finally {
      setLoading(false);
    }
  }, [month, year]);

  useFocusEffect(useCallback(() => { loadEvents(); }, [loadEvents]));

  const firstDayOfMonth = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  const days: (number | null)[] = [];
  for (let i = 0; i < firstDayOfMonth; i++) days.push(null);
  for (let d = 1; d <= daysInMonth; d++) days.push(d);
  while (days.length % 7 !== 0) days.push(null);

  const selDay = selectedDate.getDate();
  const selMonth = selectedDate.getMonth();
  const selYear = selectedDate.getFullYear();

  const dayEvents = events.filter((e) => {
    const d = new Date(e.start_time);
    return d.getDate() === selDay && d.getMonth() === selMonth && d.getFullYear() === selYear;
  });

  const hasEvents = (day: number) =>
    events.some((e) => {
      const d = new Date(e.start_time);
      return d.getDate() === day && d.getMonth() === month && d.getFullYear() === year;
    });

  const today = new Date();
  const isToday = (day: number) =>
    day === today.getDate() && month === today.getMonth() && year === today.getFullYear();
  const isSelected = (day: number) =>
    day === selDay && month === selMonth && year === selYear;

  const prevMonth = () => setCurrentDate(new Date(year, month - 1, 1));
  const nextMonth = () => setCurrentDate(new Date(year, month + 1, 1));
  const selectDay = (day: number) => setSelectedDate(new Date(year, month, day));

  const handleDeleteEvent = async (eventId: string) => {
    try {
      await eventsApi.delete(eventId);
      loadEvents();
    } catch (e) {
      console.error('Delete event failed:', e);
    }
  };

  const rows: (number | null)[][] = [];
  for (let i = 0; i < days.length; i += 7) {
    rows.push(days.slice(i, i + 7));
  }

  return (
    <SafeAreaView style={s.container} edges={['top']}>
      <View style={s.header}>
        <Text style={s.headerTitle}>Calendar</Text>
      </View>

      <View style={s.monthNav}>
        <TouchableOpacity testID="prev-month-btn" style={s.navBtn} onPress={prevMonth}>
          <MaterialIcons name="chevron-left" size={36} color={C.text} />
        </TouchableOpacity>
        <Text style={s.monthText}>{MONTH_NAMES[month]} {year}</Text>
        <TouchableOpacity testID="next-month-btn" style={s.navBtn} onPress={nextMonth}>
          <MaterialIcons name="chevron-right" size={36} color={C.text} />
        </TouchableOpacity>
      </View>

      <View style={s.dayNamesRow}>
        {DAY_NAMES.map((d, i) => (
          <Text key={i} style={s.dayName}>{d}</Text>
        ))}
      </View>

      <View style={s.grid}>
        {rows.map((row, ri) => (
          <View key={ri} style={s.gridRow}>
            {row.map((day, ci) => (
              <TouchableOpacity
                key={ci}
                testID={day ? `cal-day-${day}` : `cal-empty-${ri}-${ci}`}
                style={[
                  s.dayCell,
                  day && isSelected(day) && s.selectedDay,
                  day && isToday(day) && !isSelected(day) && s.todayDay,
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
                        day && isSelected(day) && s.selectedDayText,
                        day && isToday(day) && !isSelected(day) && s.todayText,
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

      <ScrollView style={s.eventsList} contentContainerStyle={s.eventsContent}>
        <Text style={s.eventsTitle}>
          {MONTH_NAMES[selMonth]} {selDay}, {selYear}
        </Text>
        {loading ? (
          <ActivityIndicator size="small" color={C.primary} style={{ marginTop: 20 }} />
        ) : dayEvents.length === 0 ? (
          <Text style={s.noEvents}>No events scheduled</Text>
        ) : (
          dayEvents.map((event) => (
            <View key={event.id} testID={`event-card-${event.id}`} style={s.eventCard}>
              <View style={s.eventTime}>
                <Text style={s.eventTimeText}>{formatEventTime(event.start_time)}</Text>
                <Text style={s.eventTimeDash}>—</Text>
                <Text style={s.eventTimeText}>{formatEventTime(event.end_time)}</Text>
              </View>
              <View style={s.eventInfo}>
                <Text style={s.eventTitle}>{event.title}</Text>
                {event.description ? (
                  <Text style={s.eventDesc} numberOfLines={1}>{event.description}</Text>
                ) : null}
              </View>
              <View style={s.eventActions}>
                <TouchableOpacity
                  testID={`edit-event-${event.id}`}
                  onPress={() => router.push({ pathname: '/event-editor', params: { eventId: event.id } })}
                  style={s.eventActionBtn}
                >
                  <MaterialIcons name="edit" size={22} color={C.secondary} />
                </TouchableOpacity>
                <TouchableOpacity
                  testID={`delete-event-${event.id}`}
                  onPress={() => handleDeleteEvent(event.id)}
                  style={s.eventActionBtn}
                >
                  <MaterialIcons name="delete" size={22} color={C.error} />
                </TouchableOpacity>
              </View>
            </View>
          ))
        )}
        <View style={{ height: 100 }} />
      </ScrollView>

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
  header: { paddingHorizontal: 24, paddingTop: 12, paddingBottom: 4 },
  headerTitle: { fontSize: 34, fontWeight: '700', color: C.text },
  monthNav: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 24, paddingVertical: 8,
  },
  navBtn: { width: 56, height: 56, justifyContent: 'center', alignItems: 'center' },
  monthText: { fontSize: 24, fontWeight: '600', color: C.text },
  dayNamesRow: {
    flexDirection: 'row', paddingHorizontal: 12, marginBottom: 4,
  },
  dayName: {
    flex: 1, textAlign: 'center', fontSize: 16, fontWeight: '600',
    color: C.textSec, paddingVertical: 4,
  },
  grid: { paddingHorizontal: 12 },
  gridRow: { flexDirection: 'row' },
  dayCell: {
    flex: 1, aspectRatio: 1, justifyContent: 'center', alignItems: 'center',
    margin: 2, borderRadius: 12,
  },
  selectedDay: { backgroundColor: C.primary },
  todayDay: { backgroundColor: C.surfaceHi, borderWidth: 2, borderColor: C.primary },
  dayText: { fontSize: 18, fontWeight: '500', color: C.text },
  selectedDayText: { color: C.primaryFg, fontWeight: '700' },
  todayText: { color: C.primary, fontWeight: '700' },
  dot: {
    width: 6, height: 6, borderRadius: 3, backgroundColor: C.primary,
    marginTop: 2,
  },
  dotSelected: { backgroundColor: C.primaryFg },
  eventsList: { flex: 1, marginTop: 8 },
  eventsContent: { paddingHorizontal: 24 },
  eventsTitle: { fontSize: 22, fontWeight: '600', color: C.text, marginBottom: 12 },
  noEvents: { fontSize: 18, color: C.borderSub, textAlign: 'center', marginTop: 16 },
  eventCard: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: C.surface, borderRadius: 12, padding: 16,
    borderWidth: 2, borderColor: C.borderSub, marginBottom: 12,
  },
  eventTime: { marginRight: 16 },
  eventTimeText: { fontSize: 16, fontWeight: '600', color: C.secondary },
  eventTimeDash: { fontSize: 14, color: C.borderSub, textAlign: 'center' },
  eventInfo: { flex: 1 },
  eventTitle: { fontSize: 20, fontWeight: '600', color: C.text },
  eventDesc: { fontSize: 16, color: C.textSec, marginTop: 2 },
  eventActions: { flexDirection: 'row', gap: 4 },
  eventActionBtn: { width: 44, height: 44, justifyContent: 'center', alignItems: 'center' },
  fab: {
    position: 'absolute', bottom: 24, right: 24,
    backgroundColor: C.primary, borderRadius: 36,
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 24, height: 64,
    elevation: 4,
  },
  fabText: { fontSize: 20, fontWeight: '600', color: C.primaryFg, marginLeft: 8 },
});
