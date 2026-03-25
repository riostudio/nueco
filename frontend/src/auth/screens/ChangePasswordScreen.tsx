import React, { useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  Alert,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { MaterialIcons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useChangePassword } from '../hooks/useChangePassword';
import { strings } from '../constants/strings';

const C = {
  primary: '#D84315',
  primaryFg: '#FFFFFF',
  bg: '#FDFBF7',
  surface: '#FFFFFF',
  text: '#121212',
  textSec: '#37474F',
  border: '#121212',
  borderSub: '#78909C',
  error: '#C62828',
};

export function ChangePasswordScreen() {
  const router = useRouter();
  const { changePassword, isLoading } = useChangePassword();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [errors, setErrors] = useState<{ [key: string]: string }>({});

  const handleSubmit = async () => {
    const newErrors: { [key: string]: string } = {};

    if (!currentPassword.trim()) {
      newErrors.current = strings.errorFieldRequired;
    }
    if (!newPassword.trim()) {
      newErrors.new = strings.errorFieldRequired;
    }
    if (!confirmPassword.trim()) {
      newErrors.confirm = strings.errorFieldRequired;
    } else if (newPassword !== confirmPassword) {
      newErrors.confirm = strings.errorPasswordsNoMatch;
    }

    setErrors(newErrors);
    if (Object.keys(newErrors).length > 0) return;

    const result = await changePassword(currentPassword, newPassword);

    if (result.success) {
      Alert.alert('Success', strings.snackbarPasswordUpdated);
      router.back();
    } else if (result.code === 401) {
      Alert.alert('Error', strings.snackbarWrongPassword);
    } else {
      Alert.alert('Error', strings.snackbarGenericError);
    }
  };

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <MaterialIcons name="arrow-back" size={28} color={C.text} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Change Password</Text>
        <View style={{ width: 48 }} />
      </View>

      <View style={styles.content}>
        <View style={styles.inputGroup}>
          <Text style={styles.label}>{strings.currentPassword}</Text>
          <TextInput
            style={[styles.input, errors.current && styles.inputError]}
            placeholder={strings.hintCurrentPassword}
            placeholderTextColor={C.borderSub}
            secureTextEntry
            value={currentPassword}
            onChangeText={setCurrentPassword}
          />
          {errors.current && (
            <Text style={styles.errorText}>{errors.current}</Text>
          )}
        </View>

        <View style={styles.inputGroup}>
          <Text style={styles.label}>{strings.newPassword}</Text>
          <TextInput
            style={[styles.input, errors.new && styles.inputError]}
            placeholder={strings.hintNewPassword}
            placeholderTextColor={C.borderSub}
            secureTextEntry
            value={newPassword}
            onChangeText={setNewPassword}
          />
          {errors.new && <Text style={styles.errorText}>{errors.new}</Text>}
        </View>

        <View style={styles.inputGroup}>
          <Text style={styles.label}>{strings.confirmPassword}</Text>
          <TextInput
            style={[styles.input, errors.confirm && styles.inputError]}
            placeholder={strings.hintConfirmPassword}
            placeholderTextColor={C.borderSub}
            secureTextEntry
            value={confirmPassword}
            onChangeText={setConfirmPassword}
          />
          {errors.confirm && (
            <Text style={styles.errorText}>{errors.confirm}</Text>
          )}
        </View>

        <TouchableOpacity
          style={styles.submitButton}
          onPress={handleSubmit}
          disabled={isLoading}
        >
          {isLoading ? (
            <ActivityIndicator color={C.primaryFg} />
          ) : (
            <Text style={styles.submitButtonText}>
              {strings.btnUpdatePassword}
            </Text>
          )}
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: C.bg,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: C.borderSub + '40',
  },
  backBtn: {
    width: 48,
    height: 48,
    justifyContent: 'center',
    alignItems: 'center',
  },
  headerTitle: {
    fontSize: 20,
    fontWeight: '600',
    color: C.text,
  },
  content: {
    padding: 24,
  },
  inputGroup: {
    marginBottom: 20,
  },
  label: {
    fontSize: 16,
    fontWeight: '600',
    color: C.text,
    marginBottom: 8,
  },
  input: {
    height: 56,
    borderWidth: 2,
    borderColor: C.border,
    borderRadius: 12,
    paddingHorizontal: 16,
    fontSize: 18,
    color: C.text,
    backgroundColor: C.surface,
  },
  inputError: {
    borderColor: C.error,
  },
  errorText: {
    color: C.error,
    fontSize: 14,
    marginTop: 4,
  },
  submitButton: {
    backgroundColor: C.primary,
    height: 56,
    borderRadius: 12,
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: 8,
  },
  submitButtonText: {
    color: C.primaryFg,
    fontSize: 20,
    fontWeight: '600',
  },
});
