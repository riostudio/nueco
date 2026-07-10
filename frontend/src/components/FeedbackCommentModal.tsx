/**
 * FeedbackCommentModal.tsx
 * Thumbs-down follow-up: an optional free-text comment + quick-select tag, submitted to
 * POST /feedback for AI triage server-side. Styled to match the delete-confirmation modals
 * (editor.tsx / (tabs)/index.tsx) - card, icon, title, Cancel/primary-action buttons.
 */
import React, { useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, TextInput, Modal, ActivityIndicator } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { C } from '../theme';

const TAGS: { label: string; value: string }[] = [
  { label: 'Bug', value: 'bug' },
  { label: 'Missing feature', value: 'feature' },
  { label: 'Confusing', value: 'confusing' },
  { label: 'Too slow', value: 'slow' },
  { label: 'Other', value: 'other' },
];

interface Props {
  visible: boolean;
  submitting: boolean;
  onSubmit: (tag: string | null, text: string) => void;
  onSkip: () => void;
}

export default function FeedbackCommentModal({ visible, submitting, onSubmit, onSkip }: Props) {
  const [tag, setTag] = useState<string | null>(null);
  const [text, setText] = useState('');

  const handleSubmit = () => {
    onSubmit(tag, text.trim());
    setTag(null);
    setText('');
  };

  const handleSkip = () => {
    setTag(null);
    setText('');
    onSkip();
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={handleSkip}>
      <View style={s.overlay}>
        <View style={s.card}>
          <MaterialIcons name="chat-bubble-outline" size={40} color={C.secondary} style={{ marginBottom: 12 }} />
          <Text style={s.title}>Sorry to hear that</Text>
          <Text style={s.subtitle}>Mind telling us why? Not linked to your notes.</Text>

          <View style={s.tagRow}>
            {TAGS.map((t) => (
              <TouchableOpacity
                key={t.value}
                testID={`feedback-tag-${t.value}`}
                style={[s.tagChip, tag === t.value && s.tagChipSelected]}
                onPress={() => setTag(tag === t.value ? null : t.value)}
              >
                <Text style={[s.tagText, tag === t.value && s.tagTextSelected]}>{t.label}</Text>
              </TouchableOpacity>
            ))}
          </View>

          <TextInput
            testID="feedback-comment-input"
            style={s.input}
            placeholder="What's not working for you?"
            placeholderTextColor={C.borderSub}
            value={text}
            onChangeText={setText}
            multiline
            textAlignVertical="top"
          />

          <View style={s.buttons}>
            <TouchableOpacity testID="feedback-skip-btn" style={s.skipBtn} onPress={handleSkip} disabled={submitting} activeOpacity={0.7}>
              <Text style={s.skipText}>Skip</Text>
            </TouchableOpacity>
            <TouchableOpacity testID="feedback-submit-btn" style={s.submitBtn} onPress={handleSubmit} disabled={submitting} activeOpacity={0.7}>
              {submitting ? <ActivityIndicator size="small" color="#FFFFFF" /> : <Text style={s.submitText}>Submit</Text>}
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', alignItems: 'center', padding: 24 },
  card: { backgroundColor: C.surface, borderRadius: 20, padding: 24, width: '100%', maxWidth: 380, alignItems: 'center' },
  title: { fontSize: 20, fontWeight: '700', color: C.text, marginBottom: 6 },
  subtitle: { fontSize: 14, color: C.textSec, textAlign: 'center', marginBottom: 16 },
  tagRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, justifyContent: 'center', marginBottom: 16 },
  tagChip: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 20, backgroundColor: C.bg, borderWidth: 1, borderColor: C.borderSub },
  tagChipSelected: { backgroundColor: C.primary, borderColor: C.primary },
  tagText: { fontSize: 13, color: C.textSec, fontWeight: '500' },
  tagTextSelected: { color: C.primaryFg },
  input: {
    width: '100%', minHeight: 90, borderWidth: 2, borderColor: C.borderSub, borderRadius: 12,
    paddingHorizontal: 14, paddingTop: 12, fontSize: 16, color: C.text, backgroundColor: C.bg, marginBottom: 20,
  },
  buttons: { flexDirection: 'row', gap: 12, width: '100%' },
  skipBtn: { flex: 1, paddingVertical: 14, borderRadius: 12, backgroundColor: '#E0E0E0', alignItems: 'center' },
  skipText: { fontSize: 16, fontWeight: '600', color: C.text },
  submitBtn: { flex: 1, paddingVertical: 14, borderRadius: 12, backgroundColor: C.primary, alignItems: 'center' },
  submitText: { fontSize: 16, fontWeight: '600', color: '#FFFFFF' },
});
