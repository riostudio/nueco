import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  SafeAreaView,
  TextInput,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  Alert,
} from 'react-native';
import { useRouter } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { authApi } from '../src/auth';
import { C, radius, borderWidth } from '../src/theme';
import { Button } from '../src/components';

export default function ForgotPasswordScreen() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isSubmitted, setIsSubmitted] = useState(false);
  const [error, setError] = useState('');

  const validate = () => {
    if (!email.trim()) {
      setError('Email is required');
      return false;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setError('Please enter a valid email');
      return false;
    }
    setError('');
    return true;
  };

  const handleSubmit = async () => {
    if (!validate()) return;

    setIsLoading(true);
    try {
      await authApi.forgotPassword(email.trim().toLowerCase());
      setIsSubmitted(true);
    } catch (error: any) {
      // We don't show error for security (don't reveal if email exists)
      setIsSubmitted(true);
    } finally {
      setIsLoading(false);
    }
  };

  if (isSubmitted) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.successContainer}>
          <View style={styles.successIcon}>
            <MaterialIcons name="email" size={64} color={C.success} />
          </View>
          <Text style={styles.successTitle}>Check Your Email</Text>
          <Text style={styles.successMessage}>
            If an account exists with {email}, you'll receive a password reset link shortly.
          </Text>
          <TouchableOpacity
            style={styles.backToLoginButton}
            onPress={() => router.replace('/login')}
            activeOpacity={0.8}
          >
            <Text style={styles.backToLoginText}>Back to Login</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={styles.keyboardView}
      >
        <ScrollView
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {/* Header */}
          <View style={styles.header}>
            <TouchableOpacity
              style={styles.backButton}
              onPress={() => router.back()}
              activeOpacity={0.7}
            >
              <MaterialIcons name="arrow-back" size={28} color={C.text} />
            </TouchableOpacity>
          </View>

          {/* Title */}
          <View style={styles.titleSection}>
            <View style={styles.iconContainer}>
              <MaterialIcons name="vpn-key" size={48} color={C.primary} />
            </View>
            <Text style={styles.title}>Forgot Password?</Text>
            <Text style={styles.subtitle}>
              No worries! Enter your email address and we'll send you a link to reset your password.
            </Text>
          </View>

          {/* Form */}
          <View style={styles.form}>
            {/* Email Input */}
            <View style={styles.inputGroup}>
              <Text style={styles.label}>Email Address</Text>
              <View style={[styles.inputContainer, error && styles.inputError]}>
                <MaterialIcons name="email" size={24} color={C.borderSub} style={styles.inputIcon} />
                <TextInput
                  style={styles.input}
                  placeholder="Enter your email"
                  placeholderTextColor={C.placeholder}
                  value={email}
                  onChangeText={(text) => {
                    setEmail(text);
                    if (error) setError('');
                  }}
                  keyboardType="email-address"
                  autoCapitalize="none"
                  autoComplete="email"
                />
              </View>
              {error ? <Text style={styles.errorText}>{error}</Text> : null}
            </View>

            {/* Submit Button */}
            <Button variant="cta" label="Send Reset Link" onPress={handleSubmit} loading={isLoading} style={styles.submitButton} />

            {/* Back to Login Link */}
            <TouchableOpacity
              style={styles.loginLinkButton}
              onPress={() => router.replace('/login')}
            >
              <MaterialIcons name="arrow-back" size={20} color={C.secondary} />
              <Text style={styles.loginLinkText}>Back to Login</Text>
            </TouchableOpacity>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: C.bg,
  },
  keyboardView: {
    flex: 1,
  },
  scrollContent: {
    flexGrow: 1,
    paddingHorizontal: 24,
  },
  header: {
    paddingTop: 16,
    paddingBottom: 8,
  },
  backButton: {
    width: 48,
    height: 48,
    borderRadius: radius.pill,
    backgroundColor: C.surface,
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: borderWidth.regular,
    borderColor: C.borderSub,
  },
  titleSection: {
    paddingVertical: 32,
    alignItems: 'center',
  },
  iconContainer: {
    width: 100,
    height: 100,
    borderRadius: radius.pill,
    backgroundColor: C.surfaceHi,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 24,
  },
  title: {
    fontSize: 34,
    fontWeight: '700',
    color: C.text,
    marginBottom: 12,
    textAlign: 'center',
  },
  subtitle: {
    fontSize: 18,
    color: C.icon,
    lineHeight: 26,
    textAlign: 'center',
  },
  form: {
    flex: 1,
    gap: 20,
  },
  inputGroup: {
    gap: 8,
  },
  label: {
    fontSize: 16,
    fontWeight: '600',
    color: C.textSec,
  },
  inputContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: C.surface,
    borderRadius: radius.lg,
    borderWidth: borderWidth.thick,
    borderColor: C.borderSub,
    paddingHorizontal: 16,
    minHeight: 60,
  },
  inputError: {
    borderColor: C.error,
  },
  inputIcon: {
    marginRight: 12,
  },
  input: {
    flex: 1,
    fontSize: 18,
    color: C.text,
    paddingVertical: 16,
  },
  errorText: {
    fontSize: 14,
    color: C.error,
    marginTop: 4,
  },
  submitButton: {
    marginTop: 16,
  },
  loginLinkButton: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    paddingVertical: 16,
    gap: 8,
  },
  loginLinkText: {
    fontSize: 16,
    color: C.secondary,
    fontWeight: '600',
  },
  // Success state styles
  successContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 24,
  },
  successIcon: {
    width: 120,
    height: 120,
    borderRadius: radius.pill,
    backgroundColor: C.success + '1F',
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 24,
  },
  successTitle: {
    fontSize: 28,
    fontWeight: '700',
    color: C.text,
    marginBottom: 16,
    textAlign: 'center',
  },
  successMessage: {
    fontSize: 18,
    color: C.icon,
    lineHeight: 26,
    textAlign: 'center',
    marginBottom: 32,
  },
  backToLoginButton: {
    backgroundColor: C.secondary,
    paddingVertical: 18,
    paddingHorizontal: 32,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 60,
  },
  backToLoginText: {
    color: C.secondaryFg,
    fontSize: 18,
    fontWeight: '700',
  },
});
