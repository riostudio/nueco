import React, { useCallback, useEffect, useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, TextInput, ScrollView,
  ActivityIndicator, Modal, KeyboardAvoidingView, Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { MaterialIcons } from '@expo/vector-icons';
import { useRouter, useLocalSearchParams } from 'expo-router';
import {
  getLocalTrips, createTripOffline, updateTripOffline, deleteTripOffline,
  getLocalEvents, updateEventOffline, LocalEvent,
} from '../src/offlineSync';
import { C, radius, borderWidth } from '../src/theme';
import { DAY_NAMES, MONTH_NAMES } from '../src/dateNames';

function formatEventDateTime(iso: string): string {
  const d = new Date(iso);
  const h = d.getHours();
  const m = d.getMinutes();
  const ampm = h >= 12 ? 'PM' : 'AM';
  const hour = h % 12 || 12;
  return `${DAY_NAMES[d.getDay()]}, ${MONTH_NAMES[d.getMonth()]} ${d.getDate()} · ${hour}:${m.toString().padStart(2, '0')} ${ampm}`;
}

export default function TripEditorScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ tripId?: string }>();
  const [tripId, setTripId] = useState<string | null>(params.tripId || null);
  const isEditing = !!tripId;

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [loading, setLoading] = useState(isEditing);
  const [saving, setSaving] = useState(false);
  const [linkedEvents, setLinkedEvents] = useState<LocalEvent[]>([]);

  const [showEventPicker, setShowEventPicker] = useState(false);
  const [pickerEvents, setPickerEvents] = useState<LocalEvent[]>([]);
  const [loadingPickerEvents, setLoadingPickerEvents] = useState(false);

  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const loadTripAndEvents = useCallback(async (id: string) => {
    setLoading(true);
    try {
      const [trips, events] = await Promise.all([getLocalTrips(), getLocalEvents()]);
      const trip = trips.find((t) => t.id === id);
      if (trip) {
        setName(trip.name);
        setDescription(trip.description || '');
      }
      const linked = events
        .filter((e) => e.trip_id === id && !e._pendingDelete)
        .sort((a, b) => a.start_time.localeCompare(b.start_time));
      setLinkedEvents(linked);
    } catch (e) {
      console.error('Failed to load trip:', e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (tripId) loadTripAndEvents(tripId);
  }, [tripId, loadTripAndEvents]);

  const handleSave = async () => {
    if (!name.trim()) return;
    setSaving(true);
    try {
      if (isEditing && tripId) {
        await updateTripOffline(tripId, { name: name.trim(), description }, { push: true });
        router.back();
      } else {
        const created = await createTripOffline({ name: name.trim(), description }, { push: true });
        // Switch this screen into edit mode in place so "Add Event" becomes available
        // immediately, without an extra navigation round-trip back through the trips list.
        setTripId(created.id);
        router.setParams({ tripId: created.id });
      }
    } catch (e) {
      console.error('Save trip failed:', e);
    } finally {
      setSaving(false);
    }
  };

  const confirmDelete = async () => {
    if (!tripId) return;
    setDeleting(true);
    try {
      await deleteTripOffline(tripId, { push: true });
      router.back();
    } catch (e) {
      console.error('Delete trip failed:', e);
    } finally {
      setDeleting(false);
      setShowDeleteModal(false);
    }
  };

  // Only events not already grouped into some trip can be added - excludes both this trip's
  // own linked events and any event already claimed by a different trip.
  const openEventPicker = async () => {
    setShowEventPicker(true);
    setLoadingPickerEvents(true);
    try {
      const events = await getLocalEvents();
      setPickerEvents(
        events
          .filter((e) => !e._pendingDelete && !e.trip_id)
          .sort((a, b) => a.start_time.localeCompare(b.start_time))
      );
    } catch (e) {
      console.error('Load events for picker failed:', e);
      setPickerEvents([]);
    } finally {
      setLoadingPickerEvents(false);
    }
  };

  const linkEvent = async (event: LocalEvent) => {
    if (!tripId) return;
    setShowEventPicker(false);
    try {
      await updateEventOffline(event.id, { trip_id: tripId }, { push: true });
      setLinkedEvents((prev) => [...prev, { ...event, trip_id: tripId }].sort((a, b) => a.start_time.localeCompare(b.start_time)));
    } catch (e) {
      console.error('Link event to trip failed:', e);
    }
  };

  const unlinkEvent = async (eventId: string) => {
    try {
      await updateEventOffline(eventId, { trip_id: null }, { push: true });
      setLinkedEvents((prev) => prev.filter((e) => e.id !== eventId));
    } catch (e) {
      console.error('Unlink event from trip failed:', e);
    }
  };

  if (loading) {
    return (
      <SafeAreaView style={s.container} edges={['top']}>
        <View style={s.center}>
          <ActivityIndicator size="large" color={C.primary} />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={s.container} edges={['top']}>
      <View style={s.header}>
        <TouchableOpacity testID="trip-editor-back-btn" onPress={() => router.back()} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
          <MaterialIcons name="arrow-back" size={26} color={C.text} />
        </TouchableOpacity>
        <Text style={s.headerTitle}>{isEditing ? 'Edit Trip' : 'New Trip'}</Text>
        <View style={s.headerActions}>
          {isEditing && (
            <TouchableOpacity testID="trip-delete-btn" onPress={() => setShowDeleteModal(true)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
              <MaterialIcons name="delete-outline" size={24} color={C.error} />
            </TouchableOpacity>
          )}
          <TouchableOpacity
            testID="trip-save-btn"
            onPress={handleSave}
            disabled={saving || !name.trim()}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          >
            {saving ? <ActivityIndicator color={C.primary} /> : <MaterialIcons name="check" size={26} color={name.trim() ? C.primary : C.borderSub} />}
          </TouchableOpacity>
        </View>
      </View>

      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView style={s.scroll} contentContainerStyle={s.scrollContent} keyboardShouldPersistTaps="handled">
          <TextInput
            testID="trip-name-input"
            style={s.nameInput}
            placeholder="Trip name"
            placeholderTextColor={C.placeholder}
            value={name}
            onChangeText={setName}
          />
          <TextInput
            testID="trip-description-input"
            style={s.descInput}
            placeholder="Description (optional)"
            placeholderTextColor={C.placeholder}
            value={description}
            onChangeText={setDescription}
            multiline
          />

          <View style={s.sectionHeader}>
            <Text style={s.sectionTitle}>Timeline</Text>
            {isEditing ? (
              <TouchableOpacity testID="add-event-to-trip-btn" style={s.addEventBtn} onPress={openEventPicker} activeOpacity={0.7}>
                <MaterialIcons name="add" size={18} color={C.secondary} />
                <Text style={s.addEventBtnText}>Add Event</Text>
              </TouchableOpacity>
            ) : (
              <Text style={s.hintText}>Save to add events</Text>
            )}
          </View>

          {linkedEvents.length === 0 ? (
            <Text style={s.emptyTimeline}>No events linked yet.</Text>
          ) : (
            linkedEvents.map((ev) => (
              <View key={ev.id} style={s.eventRow}>
                <MaterialIcons name="event" size={20} color={C.secondary} />
                <View style={{ flex: 1, marginLeft: 10 }}>
                  <Text style={s.eventTitle} numberOfLines={1}>{ev.title}</Text>
                  <Text style={s.eventTime} numberOfLines={1}>{formatEventDateTime(ev.start_time)}</Text>
                </View>
                <TouchableOpacity
                  testID={`unlink-event-${ev.id}`}
                  onPress={() => unlinkEvent(ev.id)}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                >
                  <MaterialIcons name="close" size={20} color={C.borderSub} />
                </TouchableOpacity>
              </View>
            ))
          )}
        </ScrollView>
      </KeyboardAvoidingView>

      {/* Add Event picker */}
      <Modal visible={showEventPicker} transparent animationType="fade" onRequestClose={() => setShowEventPicker(false)}>
        <TouchableOpacity style={s.pickerOverlay} activeOpacity={1} onPress={() => setShowEventPicker(false)}>
          <TouchableOpacity activeOpacity={1} style={s.pickerSheet}>
            <View style={s.pickerHeader}>
              <Text style={s.pickerTitle}>Add an Event</Text>
              <TouchableOpacity testID="close-trip-event-picker" onPress={() => setShowEventPicker(false)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                <MaterialIcons name="close" size={24} color={C.textSec} />
              </TouchableOpacity>
            </View>
            {loadingPickerEvents ? (
              <ActivityIndicator size="large" color={C.primary} style={{ marginVertical: 32 }} />
            ) : pickerEvents.length === 0 ? (
              <Text style={s.pickerEmpty}>No ungrouped events available. Events already in a trip aren't shown.</Text>
            ) : (
              <ScrollView style={{ maxHeight: 380 }}>
                {pickerEvents.map((ev) => (
                  <TouchableOpacity
                    key={ev.id}
                    testID={`pick-trip-event-${ev.id}`}
                    style={s.pickerRow}
                    onPress={() => linkEvent(ev)}
                    activeOpacity={0.7}
                  >
                    <MaterialIcons name="event" size={22} color={C.secondary} />
                    <View style={{ flex: 1, marginLeft: 10 }}>
                      <Text style={s.pickerRowTitle} numberOfLines={1}>{ev.title}</Text>
                      <Text style={s.pickerRowTime} numberOfLines={1}>{formatEventDateTime(ev.start_time)}</Text>
                    </View>
                    <MaterialIcons name="add-circle-outline" size={20} color={C.borderSub} />
                  </TouchableOpacity>
                ))}
              </ScrollView>
            )}
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>

      {/* Delete confirmation */}
      <Modal visible={showDeleteModal} transparent animationType="fade" onRequestClose={() => setShowDeleteModal(false)}>
        <View style={s.modalOverlay}>
          <View style={s.modalContent}>
            <MaterialIcons name="delete" size={44} color={C.error} style={{ marginBottom: 12 }} />
            <Text style={s.modalTitle}>Delete Trip?</Text>
            <Text style={s.modalMessage}>
              "{name || 'Untitled Trip'}" will be removed. Its events stay, but will no longer be grouped together.
            </Text>
            <View style={s.modalButtons}>
              <TouchableOpacity style={s.modalCancelBtn} onPress={() => setShowDeleteModal(false)} disabled={deleting}>
                <Text style={s.modalCancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity testID="confirm-delete-trip-editor" style={s.modalDeleteBtn} onPress={confirmDelete} disabled={deleting}>
                {deleting ? <ActivityIndicator color={C.primaryFg} /> : <Text style={s.modalDeleteText}>Delete</Text>}
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
  header: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingHorizontal: 20, paddingTop: 8, paddingBottom: 12,
  },
  headerTitle: { fontSize: 18, fontWeight: '700', color: C.text },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: 16 },
  scroll: { flex: 1 },
  scrollContent: { paddingHorizontal: 20, paddingBottom: 40 },
  nameInput: { fontSize: 26, fontWeight: '700', color: C.text, paddingVertical: 8 },
  descInput: { fontSize: 15, color: C.textSec, paddingVertical: 8, minHeight: 40, textAlignVertical: 'top' },
  sectionHeader: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    marginTop: 20, marginBottom: 10,
  },
  sectionTitle: { fontSize: 15, fontWeight: '700', color: C.text },
  hintText: { fontSize: 13, color: C.borderSub },
  addEventBtn: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  addEventBtnText: { fontSize: 14, fontWeight: '600', color: C.secondary },
  emptyTimeline: { fontSize: 14, color: C.borderSub, paddingVertical: 12 },
  eventRow: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: C.surface, borderRadius: radius.md,
    paddingVertical: 10, paddingHorizontal: 12,
    borderWidth: borderWidth.regular, borderColor: C.border, marginBottom: 8,
  },
  eventTitle: { fontSize: 15, fontWeight: '600', color: C.text },
  eventTime: { fontSize: 12, color: C.textSec, marginTop: 2 },
  pickerOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'flex-end' },
  pickerSheet: { backgroundColor: C.surface, borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 20, maxHeight: '70%' },
  pickerHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 },
  pickerTitle: { fontSize: 18, fontWeight: '700', color: C.text },
  pickerEmpty: { fontSize: 14, color: C.textSec, textAlign: 'center', paddingVertical: 32 },
  pickerRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: C.divider },
  pickerRowTitle: { fontSize: 15, fontWeight: '600', color: C.text },
  pickerRowTime: { fontSize: 12, color: C.textSec, marginTop: 2 },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', alignItems: 'center', padding: 24 },
  modalContent: { backgroundColor: C.surface, borderRadius: 20, padding: 24, width: '100%', maxWidth: 340, alignItems: 'center' },
  modalTitle: { fontSize: 20, fontWeight: '700', color: C.text, marginBottom: 8 },
  modalMessage: { fontSize: 15, color: C.textSec, textAlign: 'center', lineHeight: 22, marginBottom: 20 },
  modalButtons: { flexDirection: 'row', gap: 12, width: '100%' },
  modalCancelBtn: { flex: 1, paddingVertical: 14, borderRadius: 12, backgroundColor: '#E0E0E0', alignItems: 'center' },
  modalCancelText: { fontSize: 16, fontWeight: '600', color: C.text },
  modalDeleteBtn: { flex: 1, paddingVertical: 14, borderRadius: 12, backgroundColor: C.error, alignItems: 'center' },
  modalDeleteText: { fontSize: 16, fontWeight: '600', color: C.primaryFg },
});
