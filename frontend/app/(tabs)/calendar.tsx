import React, { useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, ActivityIndicator, Modal,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { MaterialIcons } from '@expo/vector-icons';
import { useRouter, useFocusEffect } from 'expo-router';
import { eventsApi } from '../../src/api';
import { CalendarEvent } from '../../src/types';
import { MONTH_NAMES, DAY_NAMES } from '../../src/theme';
import { UserAvatar, useAuth } from '../../src/auth';

const C = {
  primary: '#D84315',
  primaryFg: '#FFFFFF',
  bg: '#FDFBF7',
  surface: '#FFFFFF',
  surfaceHi: '#FFF8E1',
  text: '#121212',
  textSec: '#37474F',
  border: '#121212',
  borderSub: '#78909C',
};

export default function CalendarScreen() {
  const router = useRouter();
  const { user, logout } = useAuth();
  const [currentDate, setCurrentDate] = useState(new Date());
  const [selectedDate, setSelectedDate] = useState(new Date());
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [logoutModalVisible, setLogoutModalVisible] = useState(false);

  const handleLogout = async () => {
    await logout();
    setLogoutModalVisible(false);
    router.replace('/welcome');
  };

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

  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  const days: (number | null)[] = [];
  for (let i = 0; i < firstDay; i++) days.push(null);
  for (let d = 1; d <= daysInMonth; d++) days.push(d);
  while (days.length % 7 !== 0) days.push(null);

  const selDay = selectedDate.getDate();
  const selMonth = selectedDate.getMonth();
  const selYear = selectedDate.getFullYear();

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

  // Count events for selected day
  const selectedDayEvents = events.filter((e) => {
    const d = new Date(e.start_time);
    return d.getDate() === selDay && d.getMonth() === selMonth && d.getFullYear() === selYear;
  });

  const rows: (number | null)[][] = [];
  for (let i = 0; i < days.length; i += 7) {
    rows.push(days.slice(i, i + 7));
  }

  return (
    <SafeAreaView style={s.container} edges={['top']}>
      <View style={s.header}>
        <Text style={s.headerTitle}>Calendar</Text>
        <UserAvatar 
          user={user} 
          size={36} 
          onSignInPress={() => router.push('/login')}
          onLogout={() => setLogoutModalVisible(true)}
        />
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

      {/* Calendar Grid */}
      {loading ? (
        <View style={s.loadingGrid}>
          <ActivityIndicator size="small" color={C.primary} />
        </View>
      ) : (
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
      )}

      {/* Selected Day Info — only show when events exist */}
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

      {/* Logout Confirmation Modal */}
      <Modal
        visible={logoutModalVisible}
        transparent={true}
        animationType="fade"
        onRequestClose={() => setLogoutModalVisible(false)}
      >
        <View style={s.modalOverlay}>
          <View style={s.modalContent}>
            <MaterialIcons name="logout" size={48} color={C.primary} style={{ marginBottom: 16 }} />
            <Text style={s.modalTitle}>Log Out?</Text>
            <Text style={s.modalMessage}>Are you sure you want to log out?</Text>
            <View style={s.modalButtons}>
              <TouchableOpacity style={s.modalCancelBtn} onPress={() => setLogoutModalVisible(false)}>
                <Text style={s.modalCancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity style={s.modalLogoutBtn} onPress={handleLogout}>
                <Text style={s.modalLogoutText}>Log Out</Text>
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
  todayDay: { backgroundColor: C.surfaceHi, borderWidth: 2, borderColor: C.primary },
  dayText: { fontSize: 18, fontWeight: '500', color: C.text },
  selectedDayText: { color: C.primaryFg, fontWeight: '700' },
  todayText: { color: C.primary, fontWeight: '700' },
  dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: C.primary, marginTop: 2 },
  dotSelected: { backgroundColor: C.primaryFg },
  selectedInfo: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    marginHorizontal: 24, marginTop: 20,
    backgroundColor: C.surface, borderRadius: 12,
    borderWidth: 2, borderColor: C.borderSub, padding: 16,
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
  // Modal styles
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', alignItems: 'center', padding: 24 },
  modalContent: { backgroundColor: C.surface, borderRadius: 20, padding: 24, width: '100%', maxWidth: 340, alignItems: 'center' },
  modalTitle: { fontSize: 22, fontWeight: '700', color: C.text, marginBottom: 12 },
  modalMessage: { fontSize: 16, color: C.textSec, textAlign: 'center', marginBottom: 24 },
  modalButtons: { flexDirection: 'row', gap: 12, width: '100%' },
  modalCancelBtn: { flex: 1, paddingVertical: 14, borderRadius: 12, backgroundColor: '#E0E0E0', alignItems: 'center' },
  modalCancelText: { fontSize: 16, fontWeight: '600', color: C.text },
  modalLogoutBtn: { flex: 1, paddingVertical: 14, borderRadius: 12, backgroundColor: C.primary, alignItems: 'center' },
  modalLogoutText: { fontSize: 16, fontWeight: '600', color: '#FFFFFF' },
});
