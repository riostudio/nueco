/**
 * Key-recovery screen (Stage 3).
 *
 * Reached at login when the escrow exists but the password can no longer unwrap the
 * DEK - typically after an email-token password reset (which can't re-wrap the DEK
 * server-side). The user enters their recovery code; we unwrap the DEK and re-wrap
 * it under the new password so future logins work normally.
 */
import React, { useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, SafeAreaView, TextInput,
  ScrollView,
} from 'react-native';
import { useRouter } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { useAuth } from '../src/auth';
import { C, radius, borderWidth } from '../src/theme';
import { Button } from '../src/components';

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
          <MaterialIcons name="lock-open" size={48} color={C.primary} />
        </View>
        <Text style={styles.title}>Restore your encrypted notes</Text>
        <Text style={styles.subtitle}>
          Your password was reset, so we need your recovery code to restore access to your
          encrypted notes and link them to your new password.
        </Text>

        {error ? (
          <View style={styles.errorBox}>
            <MaterialIcons name="error" size={20} color={C.error} />
            <Text style={styles.errorText}>{error}</Text>
          </View>
        ) : null}

        <View style={styles.inputContainer}>
          <TextInput
            style={styles.input}
            placeholder="ABCD-EFGH-…"
            placeholderTextColor={C.placeholder}
            value={code}
            onChangeText={(t) => { setCode(t); if (error) setError(''); }}
            autoCapitalize="characters"
            autoCorrect={false}
            multiline
          />
        </View>

        <Button variant="cta" label="Restore access" onPress={onSubmit} loading={isLoading} style={styles.primaryButton} />

        <TouchableOpacity style={styles.skipButton} onPress={() => router.replace('/(tabs)')} disabled={isLoading}>
          <Text style={styles.skipText}>I don&apos;t have my code - skip for now</Text>
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg },
  scroll: { padding: 24, paddingTop: 48, gap: 16 },
  iconWrap: {
    width: 96, height: 96, borderRadius: radius.lg, backgroundColor: C.surfaceHi,
    justifyContent: 'center', alignItems: 'center', alignSelf: 'center',
  },
  title: { fontSize: 28, fontWeight: '700', color: C.text, textAlign: 'center' },
  subtitle: { fontSize: 16, color: C.icon, lineHeight: 23, textAlign: 'center' },
  errorBox: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    backgroundColor: C.error + '15', borderWidth: borderWidth.regular, borderColor: C.error,
    padding: 16, borderRadius: radius.md,
  },
  errorText: { flex: 1, fontSize: 15, color: C.error, lineHeight: 21 },
  inputContainer: {
    backgroundColor: C.surface, borderRadius: radius.lg, borderWidth: borderWidth.thick, borderColor: C.borderSub,
    paddingHorizontal: 16, minHeight: 64, justifyContent: 'center',
  },
  input: { fontSize: 18, color: C.text, paddingVertical: 16, letterSpacing: 1, fontFamily: 'monospace' },
  primaryButton: { marginTop: 8 },
  skipButton: { alignItems: 'center', paddingVertical: 12 },
  skipText: { fontSize: 15, color: C.borderSub, fontWeight: '500' },
});
