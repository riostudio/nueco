/**
 * Voice -> Event/Trip confirm screen. The note editor's existing mic button (editor.tsx)
 * transcribes + classifies the recording via POST /classify-voice-intent; when the intent isn't
 * plain dictation, it stages the result in `pendingVoiceEvents.ts` and pushes here. This screen
 * never records or calls the AI itself - it only lets the user review/edit the extracted
 * event(s) (and, for an itinerary, name the trip) before anything is actually saved.
 *
 * Reuses the single-event editable-confirm pattern the original (now-removed) dedicated
 * Events-tab voice flow established: title is directly editable, date/time uses the same native
 * picker event-editor.tsx already uses. For multiple_events/itinerary, the same per-event fields
 * are repeated as a list; anything beyond that (end time, recurrence details, location) is left
 * to the existing "Edit manually" path into event-editor.tsx rather than duplicating its full
 * recurrence-editing UI here.
 */
import React, { useEffect, useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, TextInput,
  ActivityIndicator, Alert, Platform, Modal, ScrollView,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { MaterialIcons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { takePendingVoiceExtraction, type PendingVoiceExtraction } from '../src/pendingVoiceEvents';
import { createEventOffline, createTripOffline } from '../src/offlineSync';
import { formatRecurrenceSummary } from '../src/recurrence';
import { ExtractedEvent } from '../src/types';
import { C, radius, borderWidth } from '../src/theme';
import { MONTH_NAMES } from '../src/dateNames';
import { Button } from '../src/components';

let DateTimePicker: any = null;
if (Platform.OS !== 'web') {
  try { DateTimePicker = require('@react-native-community/datetimepicker').default; } catch {}
}
const isIOS = Platform.OS === 'ios';
const isAndroid = Platform.OS === 'android';

function formatDisplayDateTime(d: Date): string {
  const h = d.getHours();
  const ampm = h >= 12 ? 'PM' : 'AM';
  const hour = h % 12 || 12;
  const minute = d.getMinutes().toString().padStart(2, '0');
  return `${MONTH_NAMES[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()} at ${hour}:${minute} ${ampm}`;
}

// One event card's editable state - title/startDate are editable, the rest (end time,
// location, recurrence) come along for the ride into the save payload as-is.
type DraftEvent = ExtractedEvent & { title: string; startDate: Date };

function toDraft(ev: ExtractedEvent): DraftEvent {
  return { ...ev, startDate: new Date(ev.start_time) };
}

export default function VoiceEventScreen() {
  const router = useRouter();

  const [staged, setStaged] = useState<PendingVoiceExtraction | null>(null);
  const [drafts, setDrafts] = useState<DraftEvent[]>([]);
  const [tripName, setTripName] = useState('');
  const [saving, setSaving] = useState(false);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [showTimePicker, setShowTimePicker] = useState(false);

  useEffect(() => {
    const data = takePendingVoiceExtraction();
    if (!data || data.events.length === 0) {
      // Nothing staged (e.g. screen reached directly, or a stale reload) - nothing to confirm.
      router.back();
      return;
    }
    setStaged(data);
    setDrafts(data.events.map(toDraft));
    setTripName(data.trip_name || '');
  }, [router]);

  if (!staged || drafts.length === 0) {
    return (
      <SafeAreaView style={s.container} edges={['top']}>
        <View style={s.center}>
          <ActivityIndicator size="large" color={C.primary} />
        </View>
      </SafeAreaView>
    );
  }

  const isItinerary = staged.intent === 'itinerary';
  const isBatch = drafts.length > 1;
  const anyLowConfidence = drafts.some((d) => d.confidence === 'low');

  const updateDraft = (index: number, patch: Partial<DraftEvent>) => {
    setDrafts((prev) => prev.map((d, i) => (i === index ? { ...d, ...patch } : d)));
  };

  const removeDraft = (index: number) => {
    setDrafts((prev) => prev.filter((_, i) => i !== index));
  };

  const discard = () => {
    router.back();
  };

  const editManually = () => {
    // Only offered for a single extracted event - a per-item deep-edit for a batch would need
    // its own full recurrence UI, which event-editor.tsx already owns; keep this simple.
    router.replace({ pathname: '/event-editor', params: { date: drafts[0].startDate.toISOString() } });
  };

  const saveAll = async () => {
    if (drafts.some((d) => !d.title.trim())) {
      Alert.alert('Title needed', 'Give every event a title before saving.');
      return;
    }
    if (isItinerary && !tripName.trim()) {
      Alert.alert('Trip name needed', 'Give the trip a name before saving.');
      return;
    }

    setSaving(true);
    try {
      const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      let tripId: string | null = null;
      if (isItinerary) {
        const trip = await createTripOffline({ name: tripName.trim(), description: '' }, { push: true });
        tripId = trip.id;
      }

      for (const draft of drafts) {
        const endTime = draft.end_time
          ? new Date(draft.end_time)
          : new Date(draft.startDate.getTime() + 30 * 60 * 1000);

        await createEventOffline(
          {
            title: draft.title.trim(),
            description: '',
            location: draft.location || '',
            start_time: draft.startDate.toISOString(),
            end_time: endTime.toISOString(),
            linked_note_ids: [],
            reminder_minutes: null,
            device_calendar_event_id: null,
            recurrence: draft.recurrence,
            // Same convention event-editor.tsx's buildEventData uses: only stamp timezone when
            // there's a recurrence to anchor it to.
            timezone: draft.recurrence ? timezone : null,
            trip_id: tripId,
          },
          { push: true },
        );
      }

      router.replace(isItinerary && tripId ? { pathname: '/trip-editor', params: { tripId } } : '/(tabs)/events');
    } catch (e) {
      console.error('Save voice event(s) failed:', e);
      Alert.alert('Save Failed', 'Could not save. Please try again.');
      setSaving(false);
    }
  };

  const saveLabel = isItinerary
    ? `Create Trip & Save ${drafts.length} Event${drafts.length === 1 ? '' : 's'}`
    : isBatch
      ? `Save ${drafts.length} Events`
      : 'Save Event';

  return (
    <SafeAreaView style={s.container} edges={['top']}>
      <View style={s.header}>
        <TouchableOpacity testID="voice-event-close" onPress={() => router.back()} style={s.closeBtn}>
          <MaterialIcons name="close" size={26} color={C.text} />
        </TouchableOpacity>
        <Text style={s.headerTitle}>{isItinerary ? 'Plan Trip' : isBatch ? 'Confirm Events' : 'Voice to Event'}</Text>
        <View style={s.closeBtn} />
      </View>

      <ScrollView style={s.confirmBody} contentContainerStyle={{ paddingBottom: 24 }}>
        {anyLowConfidence && (
          <View style={s.lowConfidenceBanner}>
            <MaterialIcons name="info-outline" size={18} color={C.secondary} />
            <Text style={s.lowConfidenceText}>Not 100% sure about some of this - double-check before saving.</Text>
          </View>
        )}

        {isItinerary && (
          <>
            <Text style={s.label}>Trip Name</Text>
            <TextInput
              testID="voice-trip-name-input"
              style={s.titleInput}
              value={tripName}
              onChangeText={setTripName}
              placeholder="Trip name"
              placeholderTextColor={C.borderSub}
            />
          </>
        )}

        {drafts.map((draft, index) => (
          <View key={index} style={s.eventCard}>
            {isBatch && (
              <View style={s.eventCardHeader}>
                <Text style={s.eventCardIndex}>Event {index + 1}</Text>
                {drafts.length > 1 && (
                  <TouchableOpacity
                    testID={`voice-event-remove-${index}`}
                    onPress={() => removeDraft(index)}
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                  >
                    <MaterialIcons name="close" size={20} color={C.borderSub} />
                  </TouchableOpacity>
                )}
              </View>
            )}

            <Text style={s.label}>Title</Text>
            <TextInput
              testID={`voice-event-title-input-${index}`}
              style={s.titleInput}
              value={draft.title}
              onChangeText={(text) => updateDraft(index, { title: text })}
              placeholder="Event title"
              placeholderTextColor={C.borderSub}
            />

            <Text style={s.label}>When</Text>
            <TouchableOpacity
              testID={`voice-event-datetime-btn-${index}`}
              style={s.pickerBtn}
              onPress={() => { setEditingIndex(index); setShowDatePicker(true); }}
            >
              <MaterialIcons name="event" size={22} color={C.secondary} />
              <Text style={s.pickerBtnText}>{formatDisplayDateTime(draft.startDate)}</Text>
              <MaterialIcons name="arrow-drop-down" size={26} color={C.borderSub} />
            </TouchableOpacity>

            {draft.location ? (
              <>
                <Text style={s.label}>Location</Text>
                <Text style={s.readonlyValue}>{draft.location}</Text>
              </>
            ) : null}

            {draft.recurrence ? (
              <>
                <Text style={s.label}>Repeats</Text>
                <Text style={s.readonlyValue}>{formatRecurrenceSummary(draft.recurrence)}</Text>
              </>
            ) : null}
          </View>
        ))}

        <View style={s.actions}>
          <Button
            testID="voice-event-save-btn"
            label={saveLabel}
            icon="check"
            variant="cta"
            loading={saving}
            onPress={saveAll}
          />
          {!isBatch && (
            <Button
              testID="voice-event-edit-btn"
              label="Edit Manually"
              icon="edit"
              variant="outline"
              disabled={saving}
              onPress={editManually}
            />
          )}
          <Button
            testID="voice-event-discard-btn"
            label="Discard"
            variant="toolbar"
            tone="danger"
            disabled={saving}
            onPress={discard}
          />
        </View>
      </ScrollView>

      {/* Per-event date/time picker - editingIndex selects which draft it applies to. */}
      {editingIndex !== null && isIOS && DateTimePicker && (
        <>
          {showDatePicker && (
            <Modal transparent animationType="slide">
              <View style={s.pickerModalOverlay}>
                <View style={s.pickerModalContent}>
                  <View style={s.pickerModalHeader}>
                    <Text style={s.pickerModalTitle}>Select Date</Text>
                    <TouchableOpacity onPress={() => { setShowDatePicker(false); setShowTimePicker(true); }}>
                      <Text style={s.pickerModalDone}>Next</Text>
                    </TouchableOpacity>
                  </View>
                  <DateTimePicker
                    testID="voice-event-ios-date-picker"
                    value={drafts[editingIndex].startDate}
                    mode="date"
                    display="spinner"
                    onChange={(_e: any, d?: Date) => {
                      if (!d || editingIndex === null) return;
                      const prev = drafts[editingIndex].startDate;
                      updateDraft(editingIndex, { startDate: new Date(d.getFullYear(), d.getMonth(), d.getDate(), prev.getHours(), prev.getMinutes()) });
                    }}
                    style={{ height: 200 }}
                    textColor={C.text}
                  />
                </View>
              </View>
            </Modal>
          )}
          {showTimePicker && (
            <Modal transparent animationType="slide">
              <View style={s.pickerModalOverlay}>
                <View style={s.pickerModalContent}>
                  <View style={s.pickerModalHeader}>
                    <Text style={s.pickerModalTitle}>Select Time</Text>
                    <TouchableOpacity onPress={() => { setShowTimePicker(false); setEditingIndex(null); }}>
                      <Text style={s.pickerModalDone}>Done</Text>
                    </TouchableOpacity>
                  </View>
                  <DateTimePicker
                    testID="voice-event-ios-time-picker"
                    value={drafts[editingIndex].startDate}
                    mode="time"
                    display="spinner"
                    minuteInterval={5}
                    onChange={(_e: any, d?: Date) => {
                      if (!d || editingIndex === null) return;
                      const prev = drafts[editingIndex].startDate;
                      updateDraft(editingIndex, { startDate: new Date(prev.getFullYear(), prev.getMonth(), prev.getDate(), d.getHours(), d.getMinutes()) });
                    }}
                    style={{ height: 200 }}
                    textColor={C.text}
                  />
                </View>
              </View>
            </Modal>
          )}
        </>
      )}
      {editingIndex !== null && isAndroid && DateTimePicker && (
        <>
          {showDatePicker && (
            <DateTimePicker
              testID="voice-event-android-date-picker"
              value={drafts[editingIndex].startDate}
              mode="date"
              display="default"
              onChange={(_e: any, d?: Date) => {
                setShowDatePicker(false);
                if (d && editingIndex !== null) {
                  const prev = drafts[editingIndex].startDate;
                  updateDraft(editingIndex, { startDate: new Date(d.getFullYear(), d.getMonth(), d.getDate(), prev.getHours(), prev.getMinutes()) });
                  setShowTimePicker(true);
                }
              }}
            />
          )}
          {showTimePicker && (
            <DateTimePicker
              testID="voice-event-android-time-picker"
              value={drafts[editingIndex].startDate}
              mode="time"
              display="default"
              minuteInterval={5}
              onChange={(_e: any, d?: Date) => {
                setShowTimePicker(false);
                if (d && editingIndex !== null) {
                  const prev = drafts[editingIndex].startDate;
                  updateDraft(editingIndex, { startDate: new Date(prev.getFullYear(), prev.getMonth(), prev.getDate(), d.getHours(), d.getMinutes()) });
                }
                setEditingIndex(null);
              }}
            />
          )}
        </>
      )}
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingTop: 8, paddingBottom: 12,
  },
  closeBtn: { width: 40, height: 40, justifyContent: 'center', alignItems: 'center' },
  headerTitle: { fontSize: 18, fontWeight: '700', color: C.text },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 32, gap: 24 },
  confirmBody: { flex: 1, paddingHorizontal: 20, paddingTop: 8 },
  lowConfidenceBanner: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: '#E3F2FD', borderRadius: radius.md, padding: 12, marginBottom: 16,
  },
  lowConfidenceText: { flex: 1, fontSize: 13, color: C.secondary },
  eventCard: {
    borderWidth: borderWidth.regular, borderColor: C.border, borderRadius: radius.md,
    padding: 14, marginBottom: 14, backgroundColor: C.surface,
  },
  eventCardHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  eventCardIndex: { fontSize: 13, fontWeight: '700', color: C.textSec, textTransform: 'uppercase' },
  label: { fontSize: 14, fontWeight: '600', color: C.textSec, marginTop: 16, marginBottom: 6 },
  titleInput: {
    fontSize: 20, fontWeight: '600', color: C.text,
    borderWidth: borderWidth.thick, borderColor: C.border, borderRadius: radius.md,
    paddingHorizontal: 16, height: 56,
  },
  pickerBtn: {
    flexDirection: 'row', alignItems: 'center',
    borderWidth: borderWidth.thick, borderColor: C.border, borderRadius: radius.md,
    paddingHorizontal: 16, height: 56, gap: 10,
  },
  pickerBtnText: { flex: 1, fontSize: 17, color: C.text },
  readonlyValue: { fontSize: 16, color: C.text },
  pickerModalOverlay: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.4)' },
  pickerModalContent: { backgroundColor: C.surface, borderTopLeftRadius: 20, borderTopRightRadius: 20, paddingBottom: 24 },
  pickerModalHeader: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingHorizontal: 20, paddingVertical: 16, borderBottomWidth: borderWidth.regular, borderBottomColor: C.border,
  },
  pickerModalTitle: { fontSize: 17, fontWeight: '600', color: C.text },
  pickerModalDone: { fontSize: 17, fontWeight: '600', color: C.primary },
  actions: { marginTop: 20, gap: 12 },
});
