/**
 * One-time GDPR opt-in consent for usage analytics, shown as a full screen right after the user
 * first lands in the app (gated from the tabs layout when no decision has been made yet). Analytics
 * stay OFF unless the user taps "Allow". No note content is ever collected.
 */
import React, { useEffect } from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { MaterialIcons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { hasAnalyticsDecision, setAnalyticsEnabled } from '../src/analytics';
import { C, radius } from '../src/theme';
import { Button } from '../src/components';

export default function AnalyticsConsentScreen() {
  const router = useRouter();

  // If a decision already exists (e.g. reached by accident), don't ask again.
  useEffect(() => {
    hasAnalyticsDecision().then((decided) => { if (decided) router.replace('/(tabs)'); }).catch(() => {});
  }, []);

  const choose = async (allow: boolean) => {
    await setAnalyticsEnabled(allow);
    router.replace('/(tabs)');
  };

  return (
    <SafeAreaView style={s.container}>
      <View style={s.content}>
        <View style={s.iconCircle}>
          <MaterialIcons name="insights" size={48} color={C.primary} />
        </View>
        <Text style={s.title}>Help improve MemoPad?</Text>
        <Text style={s.body}>
          Share anonymous usage data - which features you use - so we can make MemoPad better.
        </Text>
        <Text style={s.reassure}>
          Your notes, events, and personal content are never collected or sent anywhere. You can
          change this anytime in Settings → Privacy &amp; Data.
        </Text>
      </View>

      <View style={s.actions}>
        <Button testID="consent-allow" variant="cta" label="Allow anonymous analytics" onPress={() => choose(true)} />
        <TouchableOpacity testID="consent-deny" style={s.denyBtn} onPress={() => choose(false)} activeOpacity={0.7}>
          <Text style={s.denyText}>No thanks</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg, justifyContent: 'space-between' },
  content: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 28 },
  iconCircle: {
    width: 96, height: 96, borderRadius: radius.pill, backgroundColor: C.surfaceHi,
    alignItems: 'center', justifyContent: 'center', marginBottom: 28,
  },
  title: { fontSize: 28, fontWeight: '700', color: C.text, textAlign: 'center', marginBottom: 16 },
  body: { fontSize: 19, color: C.text, textAlign: 'center', lineHeight: 28, marginBottom: 16 },
  reassure: { fontSize: 16, color: C.textSec, textAlign: 'center', lineHeight: 24 },
  actions: { paddingHorizontal: 24, paddingBottom: 24, gap: 8 },
  denyBtn: { height: 52, alignItems: 'center', justifyContent: 'center' },
  denyText: { fontSize: 17, fontWeight: '600', color: C.textSec },
});
