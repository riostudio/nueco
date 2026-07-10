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
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '../src/auth';

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
          <TouchableOpacity style={styles.primaryButton} onPress={() => router.replace('/(tabs)')}>
            <Text style={styles.primaryButtonText}>Continue</Text>
          </TouchableOpacity>
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
          <Ionicons name="key" size={48} color="#D84315" />
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
          <Ionicons name="warning-outline" size={20} color="#B26A00" />
          <Text style={styles.warnText}>
            Anyone with this code can decrypt your notes. Don&apos;t store it with your password.
          </Text>
        </View>

        <TouchableOpacity
          style={styles.checkRow}
          activeOpacity={0.7}
          onPress={() => setConfirmed((v) => !v)}
        >
          <Ionicons
            name={confirmed ? 'checkbox' : 'square-outline'}
            size={26}
            color={confirmed ? '#2E7D32' : '#78909C'}
          />
          <Text style={styles.checkText}>I&apos;ve saved my recovery code somewhere safe</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.primaryButton, !confirmed && styles.primaryButtonDisabled]}
          onPress={onContinue}
          disabled={!confirmed}
          activeOpacity={0.85}
        >
          <Text style={styles.primaryButtonText}>Continue</Text>
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#FDFBF7' },
  scroll: { padding: 24, paddingTop: 48, gap: 16 },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24, gap: 16 },
  iconWrap: {
    width: 96, height: 96, borderRadius: 24, backgroundColor: '#FFF3E0',
    justifyContent: 'center', alignItems: 'center', alignSelf: 'center',
  },
  title: { fontSize: 28, fontWeight: '700', color: '#121212', textAlign: 'center' },
  subtitle: { fontSize: 16, color: '#546E7A', lineHeight: 23, textAlign: 'center' },
  body: { fontSize: 16, color: '#546E7A' },
  codeBox: {
    backgroundColor: '#FFFFFF', borderRadius: 16, borderWidth: 2, borderColor: '#D84315',
    paddingVertical: 24, paddingHorizontal: 16, alignItems: 'center',
  },
  codeText: {
    fontSize: 22, fontWeight: '700', letterSpacing: 2, color: '#121212',
    fontFamily: 'monospace', textAlign: 'center',
  },
  warnRow: {
    flexDirection: 'row', gap: 10, alignItems: 'flex-start',
    backgroundColor: '#FFF8E1', borderRadius: 12, padding: 14,
  },
  warnText: { flex: 1, fontSize: 14, color: '#8D5B00', lineHeight: 20 },
  checkRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 8 },
  checkText: { flex: 1, fontSize: 16, color: '#37474F' },
  primaryButton: {
    backgroundColor: '#D84315', paddingVertical: 18, borderRadius: 16,
    alignItems: 'center', justifyContent: 'center', minHeight: 60, marginTop: 8,
  },
  primaryButtonDisabled: { opacity: 0.5 },
  primaryButtonText: { color: '#FFFFFF', fontSize: 18, fontWeight: '700' },
});
