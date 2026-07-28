import React, { useCallback, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, FlatList, ActivityIndicator, RefreshControl, Modal } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { MaterialIcons } from '@expo/vector-icons';
import { useRouter, useFocusEffect } from 'expo-router';
import { getLocalTrips, getLocalEvents, deleteTripOffline, fullSync, LocalTrip } from '../src/offlineSync';
import { C, radius, borderWidth } from '../src/theme';

type TripRow = LocalTrip & { eventCount: number; dateRange: string | null };

function formatShortDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// Attaches each trip's event count and start_time min/max (as a display range) by scanning the
// locally-cached events - trips carry no event_ids of their own (see backend/trips/service.py's
// cascade-unset comment: the link lives on the event's trip_id, trip stays the "one" side).
function withEventStats(trips: LocalTrip[], events: { trip_id?: string | null; start_time: string }[]): TripRow[] {
  return trips.map((trip) => {
    const linked = events.filter((e) => e.trip_id === trip.id);
    let dateRange: string | null = null;
    if (linked.length > 0) {
      const sorted = [...linked].sort((a, b) => a.start_time.localeCompare(b.start_time));
      const first = formatShortDate(sorted[0].start_time);
      const last = formatShortDate(sorted[sorted.length - 1].start_time);
      dateRange = first === last ? first : `${first} - ${last}`;
    }
    return { ...trip, eventCount: linked.length, dateRange };
  });
}

export default function TripsScreen() {
  const router = useRouter();
  const [trips, setTrips] = useState<TripRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<TripRow | null>(null);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async (force?: boolean) => {
    try {
      const [localTrips, localEvents] = await Promise.all([getLocalTrips(), getLocalEvents()]);
      setTrips(withEventStats(localTrips.filter((t) => !t._pendingDelete), localEvents));
      await fullSync({ force });
      const [freshTrips, freshEvents] = await Promise.all([getLocalTrips(), getLocalEvents()]);
      setTrips(withEventStats(freshTrips.filter((t) => !t._pendingDelete), freshEvents));
    } catch (e) {
      console.error('Failed to load trips:', e);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const onRefresh = () => {
    setRefreshing(true);
    load(true);
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await deleteTripOffline(deleteTarget.id, { push: true });
      setDeleteTarget(null);
      load();
    } catch (e) {
      console.error('Delete trip failed:', e);
    } finally {
      setDeleting(false);
    }
  };

  if (loading && trips.length === 0) {
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
        <TouchableOpacity testID="trips-back-btn" onPress={() => router.back()} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
          <MaterialIcons name="arrow-back" size={26} color={C.text} />
        </TouchableOpacity>
        <Text style={s.headerTitle}>Trips</Text>
        <TouchableOpacity
          testID="new-trip-btn"
          style={s.headerIconBtn}
          onPress={() => router.push('/trip-editor')}
          activeOpacity={0.7}
        >
          <MaterialIcons name="add" size={24} color={C.text} />
        </TouchableOpacity>
      </View>

      {trips.length === 0 ? (
        <View style={s.empty}>
          <MaterialIcons name="luggage" size={72} color={C.borderSub} />
          <Text style={s.emptyTitle}>No trips yet</Text>
          <Text style={s.emptySub}>Group events into a trip to see them as one timeline.</Text>
        </View>
      ) : (
        <FlatList
          data={trips}
          keyExtractor={(t) => t.id}
          contentContainerStyle={s.listContent}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={C.primary} />}
          renderItem={({ item }) => (
            <TouchableOpacity
              testID={`trip-card-${item.id}`}
              style={s.tripCard}
              activeOpacity={0.7}
              onPress={() => router.push({ pathname: '/trip-editor', params: { tripId: item.id } })}
            >
              <View style={s.tripIconWrap}>
                <MaterialIcons name="luggage" size={22} color={C.secondary} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={s.tripName} numberOfLines={1}>{item.name || 'Untitled Trip'}</Text>
                <Text style={s.tripMeta} numberOfLines={1}>
                  {item.eventCount} event{item.eventCount === 1 ? '' : 's'}
                  {item.dateRange ? ` · ${item.dateRange}` : ''}
                </Text>
              </View>
              <TouchableOpacity
                testID={`trip-delete-${item.id}`}
                style={s.deleteBtn}
                onPress={() => setDeleteTarget(item)}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              >
                <MaterialIcons name="delete-outline" size={20} color={C.borderSub} />
              </TouchableOpacity>
            </TouchableOpacity>
          )}
        />
      )}

      <Modal visible={!!deleteTarget} transparent animationType="fade" onRequestClose={() => setDeleteTarget(null)}>
        <View style={s.modalOverlay}>
          <View style={s.modalContent}>
            <MaterialIcons name="delete" size={44} color={C.error} style={{ marginBottom: 12 }} />
            <Text style={s.modalTitle}>Delete Trip?</Text>
            <Text style={s.modalMessage}>
              "{deleteTarget?.name || 'Untitled Trip'}" will be removed. Its events stay, but will no longer be grouped together.
            </Text>
            <View style={s.modalButtons}>
              <TouchableOpacity style={s.modalCancelBtn} onPress={() => setDeleteTarget(null)} disabled={deleting}>
                <Text style={s.modalCancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity testID="confirm-delete-trip" style={s.modalDeleteBtn} onPress={confirmDelete} disabled={deleting}>
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
  headerTitle: { fontSize: 22, fontWeight: '700', color: C.text },
  headerIconBtn: {
    width: 36, height: 36, borderRadius: 18,
    justifyContent: 'center', alignItems: 'center',
    backgroundColor: C.surface, borderWidth: borderWidth.regular, borderColor: C.border,
  },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32 },
  emptyTitle: { fontSize: 20, fontWeight: '600', color: C.text, marginTop: 12 },
  emptySub: { fontSize: 15, color: C.textSec, marginTop: 6, textAlign: 'center' },
  listContent: { paddingHorizontal: 20, paddingBottom: 24 },
  tripCard: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: C.surface, borderRadius: radius.md,
    paddingVertical: 12, paddingHorizontal: 12,
    borderWidth: borderWidth.regular, borderColor: C.border, marginBottom: 8,
  },
  tripIconWrap: {
    width: 40, height: 40, borderRadius: 20, backgroundColor: C.secondaryTint,
    justifyContent: 'center', alignItems: 'center', marginRight: 12,
  },
  tripName: { fontSize: 16, fontWeight: '600', color: C.text },
  tripMeta: { fontSize: 13, color: C.textSec, marginTop: 2 },
  deleteBtn: { padding: 4, marginLeft: 8 },
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
