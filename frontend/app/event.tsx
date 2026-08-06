/**
 * Event detail - a read-first view of one event.
 *
 * WHY THIS EXISTS
 * Tapping an event used to open event-editor.tsx, which is a form: every field a live input, the
 * keyboard one tap away, autosave running. That is the right screen for building an event and the
 * wrong one for checking what time you said you'd be somewhere. Most taps on an event are people
 * reading, not editing.
 *
 * The detail rows are deliberately not inputs. Each one taps through to the editor, which opens
 * focused on that field. Reading costs nothing and edits stay explicit.
 *
 * All-day events show "All day" in place of a start/end pair. Their start_time/end_time are
 * date-only "YYYY-MM-DD" strings rather than instants, so they are parsed with parseDateOnlyLocal -
 * feeding them to `new Date()` reads them as UTC midnight and can render the previous day.
 */
import React, { useCallback, useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, ScrollView, ActivityIndicator, Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { MaterialIcons } from '@expo/vector-icons';
import { useRouter, useLocalSearchParams, useFocusEffect, type Href } from 'expo-router';
import { getLocalEvents, deleteEventOffline } from '../src/offlineSync';
import { CalendarEvent } from '../src/types';
import { C, radius } from '../src/theme';
import { MONTH_NAMES, DAY_NAMES } from '../src/dateNames';
import { parseDateOnlyLocal, formatRecurrenceSummary } from '../src/recurrence';
import { emojiForEvent } from '../src/events/eventEmoji';
import { EventCardSkeleton } from '../src/components/Skeleton';

function formatTime(d: Date): string {
  const h = d.getHours();
  const m = d.getMinutes();
  const ampm = h >= 12 ? 'PM' : 'AM';
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${ampm}`;
}

function formatLongDate(d: Date): string {
  return `${DAY_NAMES[d.getDay()]}, ${MONTH_NAMES[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

function formatReminder(minutes: number | null | undefined): string | null {
  if (!minutes) return null;
  if (minutes === 1440) return '1 day before';
  if (minutes === 60) return '1 hr before';
  return `${minutes} min before`;
}

/** One read-only row that taps through to the editor. */
function DetailRow({
  icon, label, value, onPress, testID,
}: {
  icon: React.ComponentProps<typeof MaterialIcons>['name'];
  label: string;
  value: string | null;
  onPress: () => void;
  testID?: string;
}) {
  const empty = !value;
  return (
    <TouchableOpacity style={s.row} onPress={onPress} activeOpacity={0.7} testID={testID}>
      <MaterialIcons name={icon} size={24} color={C.secondary} />
      <View style={s.rowBody}>
        <Text style={s.rowLabel}>{label}</Text>
        {/* An unset field says what it is, never "None" or an em dash - a blank-looking row is
            harder to recognise as tappable than one that names what would go in it. */}
        <Text style={[s.rowValue, empty && s.rowValueEmpty]} numberOfLines={2}>
          {value || `Add ${label.toLowerCase()}`}
        </Text>
      </View>
      <MaterialIcons name="chevron-right" size={22} color={C.borderSub} />
    </TouchableOpacity>
  );
}

export default function EventDetailScreen() {
  const router = useRouter();
  const { eventId } = useLocalSearchParams<{ eventId: string }>();
  const [event, setEvent] = useState<CalendarEvent | null>(null);
  const [loading, setLoading] = useState(true);

  // Reloads on focus so returning from the editor shows the edit rather than a stale copy.
  useFocusEffect(useCallback(() => {
    let cancelled = false;
    (async () => {
      try {
        const all = await getLocalEvents();
        const found = all.find(e => e.id === eventId && !e._pendingDelete);
        if (!cancelled) setEvent((found as CalendarEvent) || null);
      } catch (e) {
        console.error('Could not load event:', e);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [eventId]));

  const openEditor = useCallback((focus?: string) => {
    router.push(`/event-editor?eventId=${eventId}&from=detail${focus ? `&focus=${focus}` : ''}` as Href);
  }, [router, eventId]);

  const handleDelete = useCallback(() => {
    if (!event) return;
    Alert.alert('Delete this event?', event.title || 'Untitled event', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          try {
            await deleteEventOffline(event.id);
            router.back();
          } catch (e) {
            console.error('Delete failed:', e);
            Alert.alert('Couldn’t delete that event', 'It’s still in your events.');
          }
        },
      },
    ]);
  }, [event, router]);

  if (loading) {
    return (
      <SafeAreaView style={s.container} edges={['top']}>
        <View style={s.header}>
          <TouchableOpacity onPress={() => router.back()} hitSlop={12}>
            <MaterialIcons name="arrow-back" size={26} color={C.text} />
          </TouchableOpacity>
        </View>
        <View style={{ paddingHorizontal: 16 }}><EventCardSkeleton /></View>
      </SafeAreaView>
    );
  }

  if (!event) {
    return (
      <SafeAreaView style={s.container} edges={['top']}>
        <View style={s.header}>
          <TouchableOpacity onPress={() => router.back()} hitSlop={12}>
            <MaterialIcons name="arrow-back" size={26} color={C.text} />
          </TouchableOpacity>
        </View>
        <View style={s.empty}>
          <Text style={s.emptyTitle}>That event isn’t here</Text>
          <Text style={s.emptySub}>It may have been deleted.</Text>
        </View>
      </SafeAreaView>
    );
  }

  const allDay = !!event.all_day;
  const start = allDay ? parseDateOnlyLocal(event.start_time) : new Date(event.start_time);
  const end = allDay ? parseDateOnlyLocal(event.end_time) : new Date(event.end_time);
  const emoji = emojiForEvent(event.title);
  const recurrence = event.recurrence ? formatRecurrenceSummary(event.recurrence) : null;

  return (
    <SafeAreaView style={s.container} edges={['top']}>
      <View style={s.header}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={12} testID="event-back">
          <MaterialIcons name="arrow-back" size={26} color={C.text} />
        </TouchableOpacity>
        <View style={{ flex: 1 }} />
        <TouchableOpacity onPress={handleDelete} hitSlop={12} testID="event-delete">
          <MaterialIcons name="delete-outline" size={24} color={C.textSec} />
        </TouchableOpacity>
      </View>

      <ScrollView contentContainerStyle={s.scroll} showsVerticalScrollIndicator={false}>
        {/* Title and when, read large - the two things someone opened this screen to check. */}
        <TouchableOpacity activeOpacity={0.7} onPress={() => openEditor('title')} testID="event-title-block">
          <Text style={s.title}>{emoji ? `${emoji} ` : ''}{event.title || 'Untitled event'}</Text>
        </TouchableOpacity>

        <TouchableOpacity activeOpacity={0.7} onPress={() => openEditor('date')} testID="event-when-block">
          <Text style={s.when}>{formatLongDate(start)}</Text>
          {allDay ? (
            <Text style={s.whenSub}>All day</Text>
          ) : (
            <Text style={s.whenSub}>
              {formatTime(start)}
              {formatTime(end) !== formatTime(start) ? ` to ${formatTime(end)}` : ''}
            </Text>
          )}
        </TouchableOpacity>

        <View style={s.rows}>
          <DetailRow icon="place" label="Location" value={event.location || null}
            onPress={() => openEditor('location')} testID="event-row-location" />
          <DetailRow icon="notifications-none" label="Reminder"
            value={formatReminder(event.reminder_minutes)}
            onPress={() => openEditor('reminder')} testID="event-row-reminder" />
          <DetailRow icon="repeat" label="Repeat" value={recurrence}
            onPress={() => openEditor('recurrence')} testID="event-row-recurrence" />
          <DetailRow icon="notes" label="Notes" value={event.description || null}
            onPress={() => openEditor('description')} testID="event-row-description" />
        </View>

        <TouchableOpacity style={s.editAll} onPress={() => openEditor()} testID="event-edit-all">
          <MaterialIcons name="edit" size={20} color={C.primary} />
          <Text style={s.editAllText}>Edit everything</Text>
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12 },
  scroll: { paddingHorizontal: 16, paddingBottom: 48 },
  title: { fontSize: 28, fontWeight: '700', color: C.text, marginTop: 8, marginBottom: 14 },
  when: { fontSize: 17, fontWeight: '600', color: C.secondary },
  whenSub: { fontSize: 17, color: C.textSec, marginTop: 4, marginBottom: 20 },
  rows: { borderRadius: radius.md, backgroundColor: C.surface, overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 14, padding: 16 },
  rowBody: { flex: 1 },
  rowLabel: { fontSize: 13, color: C.textSec, marginBottom: 2 },
  rowValue: { fontSize: 17, color: C.text },
  rowValueEmpty: { color: C.borderSub },
  editAll: { flexDirection: 'row', alignItems: 'center', gap: 8, alignSelf: 'flex-start',
             marginTop: 22, paddingVertical: 10, paddingHorizontal: 4 },
  editAllText: { fontSize: 17, fontWeight: '600', color: C.primary },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 },
  emptyTitle: { fontSize: 20, fontWeight: '600', color: C.text, marginBottom: 8 },
  emptySub: { fontSize: 15, color: C.textSec, textAlign: 'center' },
});
