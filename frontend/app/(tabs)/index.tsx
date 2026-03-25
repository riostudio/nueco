import React, { useState, useCallback, useRef, useEffect } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, TextInput,
  ScrollView, RefreshControl, ActivityIndicator, Alert, Modal, Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { MaterialIcons } from '@expo/vector-icons';
import { useRouter, useFocusEffect } from 'expo-router';
import { notesApi } from '../../src/api';
import { Note } from '../../src/types';

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
  error: '#C62828',
};

function formatTime(dateStr: string): string {
  const d = new Date(dateStr);
  const now = new Date();
  const diff = now.getTime() - d.getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days} days ago`;
  return d.toLocaleDateString();
}

function stripMd(text: string): string {
  return text.replace(/\*\*/g, '').replace(/\*/g, '').replace(/^- /gm, '').trim();
}

export default function NotesScreen() {
  const router = useRouter();
  const [notes, setNotes] = useState<Note[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [debouncedSearch, setDebouncedSearch] = useState('');
  
  // Delete confirmation modal state
  const [deleteModalVisible, setDeleteModalVisible] = useState(false);
  const [noteToDelete, setNoteToDelete] = useState<{ id: string; title: string } | null>(null);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => {
      setDebouncedSearch(search);
    }, 400);
    return () => { if (searchTimer.current) clearTimeout(searchTimer.current); };
  }, [search]);

  const loadNotes = useCallback(async (query?: string) => {
    try {
      const data = await notesApi.getAll(query || undefined);
      setNotes(data);
    } catch (e) {
      console.error('Failed to load notes:', e);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      loadNotes(debouncedSearch || undefined);
    }, [debouncedSearch, loadNotes])
  );

  const pinnedNotes = notes.filter((n) => n.is_pinned);
  const otherNotes = notes.filter((n) => !n.is_pinned);

  const handleTogglePin = async (noteId: string) => {
    try {
      await notesApi.togglePin(noteId);
      loadNotes(debouncedSearch || undefined);
    } catch (e) {
      console.error('Toggle pin failed:', e);
    }
  };

  const handleDeletePress = (noteId: string, noteTitle: string) => {
    setNoteToDelete({ id: noteId, title: noteTitle || 'Untitled Note' });
    setDeleteModalVisible(true);
  };

  const confirmDelete = async () => {
    if (!noteToDelete) return;
    setDeleting(true);
    try {
      await notesApi.delete(noteToDelete.id);
      loadNotes(debouncedSearch || undefined);
      setDeleteModalVisible(false);
      setNoteToDelete(null);
    } catch (e) {
      console.error('Delete failed:', e);
    } finally {
      setDeleting(false);
    }
  };

  const cancelDelete = () => {
    setDeleteModalVisible(false);
    setNoteToDelete(null);
  };

  const renderCard = (note: Note) => (
    <TouchableOpacity
      key={note.id}
      testID={`note-card-${note.id}`}
      style={[s.card, note.is_pinned && s.pinnedCard]}
      onPress={() => router.push({ pathname: '/editor', params: { noteId: note.id } })}
      activeOpacity={0.7}
    >
      <View style={s.cardHead}>
        <Text style={s.cardTitle} numberOfLines={1}>
          {note.title || 'Untitled Note'}
        </Text>
        <View style={s.cardActions}>
          <TouchableOpacity
            testID={`pin-toggle-${note.id}`}
            onPress={(e) => {
              e.stopPropagation();
              handleTogglePin(note.id);
            }}
            style={s.actionBtn}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          >
            <MaterialIcons
              name="push-pin"
              size={22}
              color={note.is_pinned ? C.primary : C.borderSub}
            />
          </TouchableOpacity>
          <TouchableOpacity
            testID={`delete-note-${note.id}`}
            onPress={(e) => {
              e.stopPropagation();
              handleDeletePress(note.id, note.title);
            }}
            style={s.actionBtn}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          >
            <MaterialIcons name="delete-outline" size={22} color={C.error} />
          </TouchableOpacity>
        </View>
      </View>
      {note.content ? (
        <Text style={s.cardPreview} numberOfLines={2}>
          {stripMd(note.content).substring(0, 120)}
        </Text>
      ) : null}
      <View style={s.cardFoot}>
        <View style={s.tagsRow}>
          {note.tags.map((tag, i) => (
            <View
              key={i}
              style={[s.tagChip, { backgroundColor: tag.color + '20', borderColor: tag.color }]}
            >
              <Text style={[s.tagText, { color: tag.color }]}>{tag.name}</Text>
            </View>
          ))}
        </View>
        <Text style={s.timeText}>{formatTime(note.updated_at)}</Text>
      </View>
    </TouchableOpacity>
  );

  if (loading) {
    return (
      <SafeAreaView style={s.container}>
        <View style={s.center}>
          <ActivityIndicator size="large" color={C.primary} />
          <Text style={s.loadText}>Loading notes...</Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={s.container} edges={['top']}>
      <View style={s.header}>
        <Text style={s.headerTitle}>MemoPad</Text>
      </View>

      <View style={s.searchBox}>
        <MaterialIcons name="search" size={24} color={C.textSec} />
        <TextInput
          testID="search-input"
          style={s.searchInput}
          placeholder="Search notes..."
          placeholderTextColor={C.borderSub}
          value={search}
          onChangeText={setSearch}
          returnKeyType="search"
        />
        {search.length > 0 && (
          <TouchableOpacity testID="clear-search-btn" onPress={() => setSearch('')}>
            <MaterialIcons name="close" size={24} color={C.textSec} />
          </TouchableOpacity>
        )}
      </View>

      <ScrollView
        style={s.scroll}
        contentContainerStyle={s.scrollContent}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => { setRefreshing(true); loadNotes(debouncedSearch || undefined); }}
            colors={[C.primary]}
          />
        }
      >
        {notes.length === 0 ? (
          <View style={s.empty}>
            <MaterialIcons name="note-add" size={72} color={C.borderSub} />
            <Text style={s.emptyTitle}>
              {search ? 'No notes found' : 'No notes yet'}
            </Text>
            <Text style={s.emptySub}>
              {search ? 'Try a different search term' : 'Tap the button below to create your first note!'}
            </Text>
          </View>
        ) : (
          <>
            {pinnedNotes.length > 0 && (
              <>
                <Text style={s.section}>Pinned</Text>
                {pinnedNotes.map(renderCard)}
              </>
            )}
            {otherNotes.length > 0 && (
              <>
                {pinnedNotes.length > 0 && <Text style={s.section}>All Notes</Text>}
                {otherNotes.map(renderCard)}
              </>
            )}
          </>
        )}
        <View style={{ height: 100 }} />
      </ScrollView>

      <TouchableOpacity
        testID="create-note-btn"
        style={s.fab}
        onPress={() => router.push({ pathname: '/editor', params: { noteId: 'new' } })}
        activeOpacity={0.8}
      >
        <MaterialIcons name="add" size={32} color={C.primaryFg} />
        <Text style={s.fabText}>New Note</Text>
      </TouchableOpacity>

      {/* Delete Confirmation Modal */}
      <Modal
        visible={deleteModalVisible}
        transparent={true}
        animationType="fade"
        onRequestClose={cancelDelete}
      >
        <View style={s.modalOverlay}>
          <View style={s.modalContent}>
            <MaterialIcons name="delete" size={48} color={C.error} style={{ marginBottom: 16 }} />
            <Text style={s.modalTitle}>Delete Note?</Text>
            <Text style={s.modalMessage}>
              Are you sure you want to delete "{noteToDelete?.title}"? This action cannot be undone.
            </Text>
            <View style={s.modalButtons}>
              <TouchableOpacity
                style={s.modalCancelBtn}
                onPress={cancelDelete}
                activeOpacity={0.7}
              >
                <Text style={s.modalCancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={s.modalDeleteBtn}
                onPress={confirmDelete}
                activeOpacity={0.7}
                disabled={deleting}
              >
                {deleting ? (
                  <ActivityIndicator size="small" color="#FFFFFF" />
                ) : (
                  <Text style={s.modalDeleteText}>Delete</Text>
                )}
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
  loadText: { fontSize: 20, color: C.textSec, marginTop: 16 },
  header: { paddingHorizontal: 24, paddingTop: 12, paddingBottom: 8 },
  headerTitle: { fontSize: 34, fontWeight: '700', color: C.text, letterSpacing: 0.25 },
  searchBox: {
    flexDirection: 'row', alignItems: 'center',
    marginHorizontal: 24, marginBottom: 16,
    backgroundColor: C.surface, borderRadius: 12,
    borderWidth: 2, borderColor: C.border,
    paddingHorizontal: 16, height: 56,
  },
  searchInput: { flex: 1, fontSize: 20, color: C.text, marginLeft: 12 },
  scroll: { flex: 1 },
  scrollContent: { paddingHorizontal: 24 },
  section: { fontSize: 20, fontWeight: '600', color: C.textSec, marginBottom: 12, marginTop: 8 },
  card: {
    backgroundColor: C.surface, borderRadius: 12, padding: 20,
    borderWidth: 2, borderColor: C.borderSub, marginBottom: 16,
  },
  pinnedCard: { borderColor: C.primary, backgroundColor: C.surfaceHi },
  cardHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 },
  cardActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  actionBtn: {
    width: 44, height: 44, borderRadius: 22,
    justifyContent: 'center', alignItems: 'center',
    backgroundColor: C.bg,
  },
  cardTitle: { fontSize: 22, fontWeight: '600', color: C.text, flex: 1, marginRight: 8 },
  cardPreview: { fontSize: 18, color: C.textSec, lineHeight: 26, marginBottom: 12 },
  cardFoot: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  tagsRow: { flexDirection: 'row', flexWrap: 'wrap', flex: 1 },
  tagChip: {
    paddingHorizontal: 10, paddingVertical: 3, borderRadius: 8,
    borderWidth: 1.5, marginRight: 8, marginBottom: 4,
  },
  tagText: { fontSize: 14, fontWeight: '600' },
  timeText: { fontSize: 16, color: C.borderSub },
  empty: { alignItems: 'center', paddingTop: 80 },
  emptyTitle: { fontSize: 24, fontWeight: '600', color: C.text, marginTop: 16 },
  emptySub: { fontSize: 18, color: C.textSec, marginTop: 8, textAlign: 'center', paddingHorizontal: 32 },
  fab: {
    position: 'absolute', bottom: 24, right: 24,
    backgroundColor: C.primary, borderRadius: 36,
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 24, height: 64,
    elevation: 4,
  },
  fabText: { fontSize: 20, fontWeight: '600', color: C.primaryFg, marginLeft: 8 },
  // Modal styles
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  modalContent: {
    backgroundColor: C.surface,
    borderRadius: 20,
    padding: 24,
    width: '100%',
    maxWidth: 340,
    alignItems: 'center',
  },
  modalTitle: {
    fontSize: 22,
    fontWeight: '700',
    color: C.text,
    marginBottom: 12,
  },
  modalMessage: {
    fontSize: 16,
    color: C.textSec,
    textAlign: 'center',
    lineHeight: 24,
    marginBottom: 24,
  },
  modalButtons: {
    flexDirection: 'row',
    gap: 12,
    width: '100%',
  },
  modalCancelBtn: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: 12,
    backgroundColor: '#E0E0E0',
    alignItems: 'center',
  },
  modalCancelText: {
    fontSize: 16,
    fontWeight: '600',
    color: C.text,
  },
  modalDeleteBtn: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: 12,
    backgroundColor: C.error,
    alignItems: 'center',
  },
  modalDeleteText: {
    fontSize: 16,
    fontWeight: '600',
    color: '#FFFFFF',
  },
});
