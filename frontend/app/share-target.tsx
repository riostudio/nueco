/**
 * Shown right after an OS share lands (see ShareIntentHandler.tsx), before the editor opens.
 * Lets the user choose whether the shared content becomes a new note or gets appended into an
 * existing one, instead of always forcing a new note. The draft itself stays staged in
 * pendingShareDraft.ts - this screen only peeks at it for the preview line and routes onward;
 * the editor is the sole consumer (see editor.tsx's two shared-draft effects).
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, TextInput, FlatList } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { MaterialIcons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { C, radius, borderWidth } from '../src/theme';
import { getLocalNotes, LocalNote } from '../src/offlineSync';
import { plainTextFromContent } from '../src/textContent';
import { peekPendingShareDraft, clearPendingShareDraft } from '../src/share/pendingShareDraft';

function sharePreviewLabel(): string {
  const draft = peekPendingShareDraft();
  if (!draft) return 'Shared content';
  if (draft.sourcePost) return draft.sourcePost.title || draft.sourcePost.url;
  if (draft.title) return draft.title;
  if (draft.content) return plainTextFromContent(draft.content).slice(0, 80);
  if (draft.images.length) return draft.images.length > 1 ? `${draft.images.length} photos` : 'Photo';
  if (draft.pendingFiles.length) return draft.pendingFiles[0].name;
  return 'Shared content';
}

export default function ShareTargetScreen() {
  const router = useRouter();
  const [notes, setNotes] = useState<LocalNote[]>([]);
  const [search, setSearch] = useState('');
  const preview = useMemo(sharePreviewLabel, []);

  useEffect(() => {
    getLocalNotes().then((all) => {
      setNotes(all.filter((n) => !n._pendingDelete).sort((a, b) => b.updated_at.localeCompare(a.updated_at)));
    });
  }, []);

  const filtered = search.trim()
    ? notes.filter((n) => {
        const q = search.trim().toLowerCase();
        return n.title.toLowerCase().includes(q) || plainTextFromContent(n.content).toLowerCase().includes(q);
      })
    : notes;

  const cancel = useCallback(() => {
    clearPendingShareDraft();
    router.back();
  }, [router]);

  const createNew = useCallback(() => {
    router.replace({ pathname: '/editor', params: { noteId: 'new', shared: '1' } });
  }, [router]);

  const pickExisting = useCallback((id: string) => {
    router.replace({ pathname: '/editor', params: { noteId: id, shared: '1' } });
  }, [router]);

  return (
    <SafeAreaView style={s.container} edges={['top']}>
      <View style={s.header}>
        <TouchableOpacity testID="share-target-cancel" style={s.headerBtn} onPress={cancel}>
          <MaterialIcons name="close" size={26} color={C.text} />
        </TouchableOpacity>
        <Text style={s.headerTitle}>Add to Nueco</Text>
        <View style={{ width: 26 }} />
      </View>
      <Text style={s.preview} numberOfLines={2}>{preview}</Text>

      <TouchableOpacity testID="share-target-new-note" style={s.newNoteRow} onPress={createNew} activeOpacity={0.7}>
        <View style={s.newNoteIcon}>
          <MaterialIcons name="note-add" size={22} color={C.primaryFg} />
        </View>
        <Text style={s.newNoteLabel}>New note</Text>
        <MaterialIcons name="chevron-right" size={22} color={C.borderSub} />
      </TouchableOpacity>

      <Text style={s.sectionLabel}>Or add to an existing note</Text>

      <View style={s.searchBox}>
        <MaterialIcons name="search" size={22} color={C.textSec} />
        <TextInput
          testID="share-target-search"
          style={s.searchInput}
          placeholder="Search notes..."
          placeholderTextColor={C.borderSub}
          value={search}
          onChangeText={setSearch}
        />
      </View>

      <FlatList
        style={s.list}
        contentContainerStyle={s.listContent}
        data={filtered}
        keyExtractor={(item) => item.id}
        keyboardShouldPersistTaps="handled"
        ListEmptyComponent={<Text style={s.empty}>{search ? 'Nothing matched that' : 'Nothing here yet'}</Text>}
        renderItem={({ item }) => {
          const snippet = plainTextFromContent(item.content).trim();
          return (
            <TouchableOpacity
              testID={`share-target-note-${item.id}`}
              style={s.noteRow}
              onPress={() => pickExisting(item.id)}
              activeOpacity={0.7}
            >
              <Text style={s.noteTitle} numberOfLines={1}>{item.title || 'Untitled'}</Text>
              {snippet ? <Text style={s.noteSnippet} numberOfLines={1}>{snippet}</Text> : null}
            </TouchableOpacity>
          );
        }}
      />
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingTop: 8, paddingBottom: 4,
  },
  headerBtn: { padding: 8 },
  headerTitle: { fontSize: 18, fontWeight: '700', color: C.text },
  preview: {
    fontSize: 14, color: C.textSec, paddingHorizontal: 24, marginTop: 4, marginBottom: 16,
  },
  newNoteRow: {
    flexDirection: 'row', alignItems: 'center', marginHorizontal: 24,
    backgroundColor: C.surface, borderRadius: radius.md,
    borderWidth: borderWidth.regular, borderColor: C.border,
    paddingVertical: 14, paddingHorizontal: 16,
  },
  newNoteIcon: {
    width: 36, height: 36, borderRadius: radius.sm, backgroundColor: C.primary,
    alignItems: 'center', justifyContent: 'center', marginRight: 12,
  },
  newNoteLabel: { flex: 1, fontSize: 17, fontWeight: '600', color: C.text },
  sectionLabel: {
    fontSize: 13, fontWeight: '600', color: C.textSec, textTransform: 'uppercase',
    letterSpacing: 0.4, marginHorizontal: 24, marginTop: 24, marginBottom: 8,
  },
  searchBox: {
    flexDirection: 'row', alignItems: 'center', marginHorizontal: 24, marginBottom: 8,
    backgroundColor: C.surface, borderRadius: radius.md,
    borderWidth: borderWidth.regular, borderColor: C.border,
    paddingHorizontal: 14, height: 46,
  },
  searchInput: { flex: 1, fontSize: 16, color: C.text, marginLeft: 8 },
  list: { flex: 1 },
  listContent: { paddingHorizontal: 24, paddingBottom: 24 },
  empty: { textAlign: 'center', color: C.textSec, fontSize: 14, marginTop: 24 },
  noteRow: {
    paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: C.borderSub + '30',
  },
  noteTitle: { fontSize: 16, fontWeight: '600', color: C.text },
  noteSnippet: { fontSize: 13, color: C.textSec, marginTop: 2 },
});
