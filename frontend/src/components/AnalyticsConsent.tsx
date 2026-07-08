/**
 * One-time GDPR opt-in consent prompt for usage analytics. Analytics stay OFF unless the user taps
 * "Allow", and the prompt only shows until they've answered once (stored via the analytics module).
 * Rendered inside the authenticated app (tabs layout). No note content is ever collected.
 */
import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Modal, Platform } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { hasAnalyticsDecision, setAnalyticsEnabled } from '../analytics';

const C = {
  primary: '#D84315',
  primaryFg: '#FFFFFF',
  surface: '#FFFFFF',
  text: '#121212',
  textSec: '#37474F',
  borderSub: '#78909C',
};

export function AnalyticsConsent() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (Platform.OS === 'web') return;
    hasAnalyticsDecision().then((decided) => { if (!decided) setVisible(true); }).catch(() => {});
  }, []);

  const choose = async (allow: boolean) => {
    setVisible(false);
    await setAnalyticsEnabled(allow);
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={() => choose(false)}>
      <View style={s.overlay}>
        <View style={s.card}>
          <MaterialIcons name="insights" size={44} color={C.primary} style={{ marginBottom: 12 }} />
          <Text style={s.title}>Help improve MemoPad?</Text>
          <Text style={s.body}>
            Share anonymous usage data (which features you use) so we can make the app better. Your
            note content is never collected. You can change this anytime in Settings.
          </Text>
          <TouchableOpacity testID="analytics-allow" style={s.allowBtn} onPress={() => choose(true)} activeOpacity={0.8}>
            <Text style={s.allowText}>Allow</Text>
          </TouchableOpacity>
          <TouchableOpacity testID="analytics-deny" style={s.denyBtn} onPress={() => choose(false)} activeOpacity={0.7}>
            <Text style={s.denyText}>No thanks</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', alignItems: 'center', padding: 24 },
  card: { backgroundColor: C.surface, borderRadius: 20, padding: 24, width: '100%', maxWidth: 360, alignItems: 'center' },
  title: { fontSize: 22, fontWeight: '700', color: C.text, marginBottom: 12, textAlign: 'center' },
  body: { fontSize: 16, color: C.textSec, textAlign: 'center', lineHeight: 24, marginBottom: 20 },
  allowBtn: { width: '100%', height: 52, borderRadius: 12, backgroundColor: C.primary, alignItems: 'center', justifyContent: 'center' },
  allowText: { fontSize: 18, fontWeight: '600', color: C.primaryFg },
  denyBtn: { width: '100%', height: 48, alignItems: 'center', justifyContent: 'center', marginTop: 8 },
  denyText: { fontSize: 16, fontWeight: '500', color: C.textSec },
});
