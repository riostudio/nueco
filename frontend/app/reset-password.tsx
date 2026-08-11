import React, { useState, useEffect } from 'react';
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
} from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { authApi } from '../src/auth';
import { C, radius, borderWidth } from '../src/theme';
import { Button, EyeIcon } from '../src/components';

export default function ResetPasswordScreen() {
  const router = useRouter();
  const { token } = useLocalSearchParams<{ token: string }>();
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isSuccess, setIsSuccess] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const validate = () => {
    const newErrors: Record<string, string> = {};

    if (!password) {
      newErrors.password = 'Password is required';
    } else if (password.length < 8) {
      newErrors.password = 'Password must be at least 8 characters';
    }

    if (!confirmPassword) {
      newErrors.confirmPassword = 'Please confirm your password';
    } else if (password !== confirmPassword) {
      newErrors.confirmPassword = 'Passwords do not match';
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleResetPassword = async () => {
    if (!validate()) return;

    if (!token) {
      setErrors({ general: 'Invalid reset link. Please request a new password reset.' });
      return;
    }

    setIsLoading(true);
    try {
      await authApi.resetPassword(token, password, confirmPassword);
      setIsSuccess(true);
    } catch (error: any) {
      setErrors({ general: error.message || 'Failed to reset password. The link may have expired.' });
    } finally {
      setIsLoading(false);
    }
  };

  // Success screen
  if (isSuccess) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.successContainer}>
          <View style={styles.successIcon}>
            <MaterialIcons name="check-circle" size={80} color={C.success} />
          </View>
          <Text style={styles.successTitle}>Password reset</Text>
          <Text style={styles.successMessage}>
            Your password has been successfully changed. You can now log in with your new password.
          </Text>
          <Button variant="cta" label="Go to Login" onPress={() => router.replace('/login')} style={styles.submitButton} />
        </View>
      </SafeAreaView>
    );
  }

  // No token provided
  if (!token) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.errorContainer}>
          <View style={styles.errorIcon}>
            <MaterialIcons name="error" size={80} color={C.error} />
          </View>
          <Text style={styles.errorTitle}>That link didn’t work</Text>
          <Text style={styles.errorMessage}>
            This password reset link is invalid or has expired. Please request a new one.
          </Text>
          <Button variant="cta" label="Request New Link" onPress={() => router.replace('/forgot-password')} style={styles.submitButton} />
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
              onPress={() => router.replace('/login')}
              activeOpacity={0.7}
            >
              <MaterialIcons name="arrow-back" size={28} color={C.text} />
            </TouchableOpacity>
          </View>

          {/* Title */}
          <View style={styles.titleSection}>
            <View style={styles.iconContainer}>
              <MaterialIcons name="lock-open" size={48} color={C.primary} />
            </View>
            <Text style={styles.title}>Create new password</Text>
            <Text style={styles.subtitle}>
              Enter your new password below. Make sure it's at least 8 characters long.
            </Text>
          </View>

          {/* Form */}
          <View style={styles.form}>
            {/* General Error */}
            {errors.general ? (
              <View style={styles.generalErrorContainer}>
                <MaterialIcons name="error" size={20} color={C.error} />
                <Text style={styles.generalErrorText}>{errors.general}</Text>
              </View>
            ) : null}

            {/* New Password Input */}
            <View style={styles.inputGroup}>
              <Text style={styles.label}>New password</Text>
              <View style={[styles.inputContainer, errors.password && styles.inputError]}>
                <MaterialIcons name="lock-outline" size={24} color={C.borderSub} style={styles.inputIcon} />
                <TextInput
                  style={styles.input}
                  placeholder="Enter new password"
                  placeholderTextColor={C.placeholder}
                  value={password}
                  onChangeText={(text) => {
                    setPassword(text);
                    if (errors.password) setErrors({ ...errors, password: '' });
                  }}
                  secureTextEntry={!showPassword}
                  autoComplete="new-password"
                />
                <TouchableOpacity
                  onPress={() => setShowPassword(!showPassword)}
                  style={styles.eyeButton}
                >
                  <EyeIcon off={showPassword} size={24} color={C.borderSub} />
                </TouchableOpacity>
              </View>
              {errors.password ? <Text style={styles.errorText}>{errors.password}</Text> : null}
              <Text style={styles.hint}>At least 8 characters</Text>
            </View>

            {/* Confirm Password Input */}
            <View style={styles.inputGroup}>
              <Text style={styles.label}>Confirm password</Text>
              <View style={[styles.inputContainer, errors.confirmPassword && styles.inputError]}>
                <MaterialIcons name="lock-outline" size={24} color={C.borderSub} style={styles.inputIcon} />
                <TextInput
                  style={styles.input}
                  placeholder="Confirm new password"
                  placeholderTextColor={C.placeholder}
                  value={confirmPassword}
                  onChangeText={(text) => {
                    setConfirmPassword(text);
                    if (errors.confirmPassword) setErrors({ ...errors, confirmPassword: '' });
                  }}
                  secureTextEntry={!showConfirmPassword}
                  autoComplete="new-password"
                />
                <TouchableOpacity
                  onPress={() => setShowConfirmPassword(!showConfirmPassword)}
                  style={styles.eyeButton}
                >
                  <EyeIcon off={showConfirmPassword} size={24} color={C.borderSub} />
                </TouchableOpacity>
              </View>
              {errors.confirmPassword ? <Text style={styles.errorText}>{errors.confirmPassword}</Text> : null}
            </View>

            {/* Submit Button */}
            <Button variant="cta" label="Reset Password" onPress={handleResetPassword} loading={isLoading} style={styles.submitButton} />
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
  eyeButton: {
    padding: 8,
  },
  errorText: {
    fontSize: 14,
    color: C.error,
    marginTop: 4,
  },
  hint: {
    fontSize: 14,
    color: C.borderSub,
    marginTop: 4,
  },
  submitButton: {
    width: '100%',
    marginTop: 16,
  },
  // General error styles
  generalErrorContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: C.error + '15',
    borderWidth: borderWidth.regular,
    borderColor: C.error,
    padding: 16,
    borderRadius: radius.md,
    gap: 12,
    marginBottom: 8,
  },
  generalErrorText: {
    flex: 1,
    fontSize: 16,
    color: C.error,
    lineHeight: 22,
  },
  // Success screen styles
  successContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 24,
  },
  successIcon: {
    marginBottom: 24,
  },
  successTitle: {
    fontSize: 32,
    fontWeight: '700',
    color: C.text,
    marginBottom: 16,
    textAlign: 'center',
  },
  successMessage: {
    fontSize: 18,
    color: C.icon,
    textAlign: 'center',
    lineHeight: 26,
    marginBottom: 32,
    paddingHorizontal: 16,
  },
  // Error screen styles
  errorContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 24,
  },
  errorIcon: {
    marginBottom: 24,
  },
  errorTitle: {
    fontSize: 32,
    fontWeight: '700',
    color: C.text,
    marginBottom: 16,
    textAlign: 'center',
  },
  errorMessage: {
    fontSize: 18,
    color: C.icon,
    textAlign: 'center',
    lineHeight: 26,
    marginBottom: 32,
    paddingHorizontal: 16,
  },
});
