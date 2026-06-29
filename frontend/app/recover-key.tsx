/**
 * Key-recovery screen (Stage 3).
 *
 * Reached at login when the escrow exists but the password can no longer unwrap the
 * DEK — typically after an email-token password reset (which can't re-wrap the DEK
 * server-side). The user enters their recovery code; we unwrap the DEK and re-wrap
 * it under the new password so future logins work normally.
 */
import React, { useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, SafeAreaView, TextInput,
  ScrollView, ActivityIndicator,
} from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '../src/auth';

export default function RecoverKeyScreen() {
  const router = useRouter();
  const { recoverKey } = useAuth();
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  const onSubmit = async () => {
    if (!code.trim()) {
      setError('Enter your recovery code');
      return;
    }
    setIsLoading(true);
    setError('');
    try {
      await recoverKey(code.trim());
      router.replace('/(tabs)');
    } catch {
      setError('That recovery code didn’t work. Check it and try again.');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
        <View style={styles.iconWrap}>
          <Ionicons name="lock-open" size={48} color="#D84315" />
        </View>
        <Text style={styles.title}>Restore your encrypted notes</Text>
        <Text style={styles.subtitle}>
          Your password was reset, so we need your recovery code to restore access to your
          encrypted notes and link them to your new password.
        </Text>

        {error ? (
          <View style={styles.errorBox}>
            <Ionicons name="alert-circle" size={20} color="#C62828" />
            <Text style={styles.errorText}>{error}</Text>
          </View>
        ) : null}

        <View style={styles.inputContainer}>
          <TextInput
            style={styles.input}
            placeholder="ABCD-EFGH-…"
            placeholderTextColor="#90A4AE"
            value={code}
            onChangeText={(t) => { setCode(t); if (error) setError(''); }}
            autoCapitalize="characters"
            autoCorrect={false}
            multiline
          />
        </View>

        <TouchableOpacity
          style={[styles.primaryButton, isLoading && styles.primaryButtonDisabled]}
          onPress={onSubmit}
          disabled={isLoading}
          activeOpacity={0.85}
        >
          {isLoading ? <ActivityIndicator color="#FFF" /> : <Text style={styles.primaryButtonText}>Restore access</Text>}
        </TouchableOpacity>

        <TouchableOpacity style={styles.skipButton} onPress={() => router.replace('/(tabs)')} disabled={isLoading}>
          <Text style={styles.skipText}>I don&apos;t have my code — skip for now</Text>
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#FDFBF7' },
  scroll: { padding: 24, paddingTop: 48, gap: 16 },
  iconWrap: {
    width: 96, height: 96, borderRadius: 24, backgroundColor: '#FFF3E0',
    justifyContent: 'center', alignItems: 'center', alignSelf: 'center',
  },
  title: { fontSize: 28, fontWeight: '700', color: '#121212', textAlign: 'center' },
  subtitle: { fontSize: 16, color: '#546E7A', lineHeight: 23, textAlign: 'center' },
  errorBox: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    backgroundColor: '#FFEBEE', padding: 16, borderRadius: 12,
  },
  errorText: { flex: 1, fontSize: 15, color: '#C62828', lineHeight: 21 },
  inputContainer: {
    backgroundColor: '#FFFFFF', borderRadius: 16, borderWidth: 2, borderColor: '#E0E0E0',
    paddingHorizontal: 16, minHeight: 64, justifyContent: 'center',
  },
  input: { fontSize: 18, color: '#121212', paddingVertical: 16, letterSpacing: 1, fontFamily: 'monospace' },
  primaryButton: {
    backgroundColor: '#D84315', paddingVertical: 18, borderRadius: 16,
    alignItems: 'center', justifyContent: 'center', minHeight: 60, marginTop: 8,
  },
  primaryButtonDisabled: { opacity: 0.6 },
  primaryButtonText: { color: '#FFFFFF', fontSize: 18, fontWeight: '700' },
  skipButton: { alignItems: 'center', paddingVertical: 12 },
  skipText: { fontSize: 15, color: '#78909C', fontWeight: '500' },
});
