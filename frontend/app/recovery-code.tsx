/**
 * One-time recovery-code screen (Stage 3).
 *
 * Shown immediately after a fresh key escrow is created at first login. The code
 * is the ONLY way to recover the DEK if the password is later reset via email, so
 * the screen blocks until the user confirms they've saved it. The code is never
 * shown again (the server only stores it wrapped).
 */
import React, { useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, SafeAreaView, ScrollView } from 'react-native';
import { useRouter } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { useAuth } from '../src/auth';
import { C, radius, borderWidth } from '../src/theme';
import { Button } from '../src/components';

export default function RecoveryCodeScreen() {
  const router = useRouter();
  const { recoveryCode, acknowledgeRecoveryCode } = useAuth();
  const [confirmed, setConfirmed] = useState(false);

  // Reached without a pending code (e.g. back-nav / reload) - nothing to show.
  if (!recoveryCode) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.centered}>
          <Text style={styles.body}>No recovery code to display.</Text>
          <Button variant="cta" label="Continue" onPress={() => router.replace('/(tabs)')} style={styles.primaryButton} />
        </View>
      </SafeAreaView>
    );
  }

  const onContinue = () => {
    acknowledgeRecoveryCode();
    router.replace('/(tabs)');
  };

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        <View style={styles.iconWrap}>
          <MaterialIcons name="vpn-key" size={48} color={C.primary} />
        </View>
        <Text style={styles.title}>Save your recovery code</Text>
        <Text style={styles.subtitle}>
          This code can restore access to your encrypted notes if you ever reset your password.
          Write it down and keep it somewhere safe - we can&apos;t show it again, and without it a
          password reset will make your notes unrecoverable.
        </Text>

        <View style={styles.codeBox}>
          <Text style={styles.codeText} selectable>
            {recoveryCode}
          </Text>
        </View>

        <View style={styles.warnRow}>
          <MaterialIcons name="warning" size={20} color="#B26A00" />
          <Text style={styles.warnText}>
            Anyone with this code can decrypt your notes. Don&apos;t store it with your password.
          </Text>
        </View>

        <TouchableOpacity
          style={styles.checkRow}
          activeOpacity={0.7}
          onPress={() => setConfirmed((v) => !v)}
        >
          <MaterialIcons
            name={confirmed ? 'check-box' : 'check-box-outline-blank'}
            size={26}
            color={confirmed ? C.success : C.borderSub}
          />
          <Text style={styles.checkText}>I&apos;ve saved my recovery code somewhere safe</Text>
        </TouchableOpacity>

        <Button variant="cta" label="Continue" onPress={onContinue} disabled={!confirmed} style={styles.primaryButton} />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg },
  scroll: { padding: 24, paddingTop: 48, gap: 16 },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24, gap: 16 },
  iconWrap: {
    width: 96, height: 96, borderRadius: radius.lg, backgroundColor: C.surfaceHi,
    justifyContent: 'center', alignItems: 'center', alignSelf: 'center',
  },
  title: { fontSize: 28, fontWeight: '700', color: C.text, textAlign: 'center' },
  subtitle: { fontSize: 16, color: C.icon, lineHeight: 23, textAlign: 'center' },
  body: { fontSize: 16, color: C.icon },
  codeBox: {
    backgroundColor: C.surface, borderRadius: radius.lg, borderWidth: borderWidth.thick, borderColor: C.primary,
    paddingVertical: 24, paddingHorizontal: 16, alignItems: 'center',
  },
  codeText: {
    fontSize: 22, fontWeight: '700', letterSpacing: 2, color: C.text,
    fontFamily: 'monospace', textAlign: 'center',
  },
  warnRow: {
    flexDirection: 'row', gap: 10, alignItems: 'flex-start',
    backgroundColor: C.surfaceHi, borderRadius: radius.md, padding: 14,
  },
  warnText: { flex: 1, fontSize: 14, color: '#8D5B00', lineHeight: 20 },
  checkRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 8 },
  checkText: { flex: 1, fontSize: 16, color: C.textSec },
  primaryButton: { marginTop: 8 },
});
