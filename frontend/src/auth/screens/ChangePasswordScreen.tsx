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
import { EyeIcon } from '../../components/EyeIcon';
import { C, radius, borderWidth } from '../../theme';

export function ChangePasswordScreen() {
  const router = useRouter();
  const { changePassword, isLoading } = useChangePassword();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [errors, setErrors] = useState<{ [key: string]: string }>({});
  // Per-field show/hide toggles for the password inputs.
  const [showCurrent, setShowCurrent] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);

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
          <MaterialIcons name="arrow-back" size={28} color={C.textSec} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Change password</Text>
        <View style={{ width: 48 }} />
      </View>

      <View style={styles.content}>
        <View style={styles.inputGroup}>
          <Text style={styles.label}>{strings.currentPassword}</Text>
          <View style={[styles.inputRow, errors.current && styles.inputError]}>
            <TextInput
              style={styles.inputFlex}
              placeholder={strings.hintCurrentPassword}
              placeholderTextColor={C.borderSub}
              secureTextEntry={!showCurrent}
              value={currentPassword}
              onChangeText={setCurrentPassword}
            />
            <TouchableOpacity
              onPress={() => setShowCurrent(!showCurrent)}
              style={styles.eyeButton}
              hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            >
              <EyeIcon off={showCurrent} size={24} color={C.borderSub} />
            </TouchableOpacity>
          </View>
          {errors.current && (
            <Text style={styles.errorText}>{errors.current}</Text>
          )}
        </View>

        <View style={styles.inputGroup}>
          <Text style={styles.label}>{strings.newPassword}</Text>
          <View style={[styles.inputRow, errors.new && styles.inputError]}>
            <TextInput
              style={styles.inputFlex}
              placeholder={strings.hintNewPassword}
              placeholderTextColor={C.borderSub}
              secureTextEntry={!showNew}
              value={newPassword}
              onChangeText={setNewPassword}
            />
            <TouchableOpacity
              onPress={() => setShowNew(!showNew)}
              style={styles.eyeButton}
              hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            >
              <EyeIcon off={showNew} size={24} color={C.borderSub} />
            </TouchableOpacity>
          </View>
          {errors.new && <Text style={styles.errorText}>{errors.new}</Text>}
        </View>

        <View style={styles.inputGroup}>
          <Text style={styles.label}>{strings.confirmPassword}</Text>
          <View style={[styles.inputRow, errors.confirm && styles.inputError]}>
            <TextInput
              style={styles.inputFlex}
              placeholder={strings.hintConfirmPassword}
              placeholderTextColor={C.borderSub}
              secureTextEntry={!showConfirm}
              value={confirmPassword}
              onChangeText={setConfirmPassword}
            />
            <TouchableOpacity
              onPress={() => setShowConfirm(!showConfirm)}
              style={styles.eyeButton}
              hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            >
              <EyeIcon off={showConfirm} size={24} color={C.borderSub} />
            </TouchableOpacity>
          </View>
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
  // Bordered container holding the password TextInput + the show/hide eye toggle.
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    height: 56,
    borderWidth: borderWidth.thick,
    borderColor: C.border,
    borderRadius: radius.md,
    paddingLeft: 16,
    paddingRight: 8,
    backgroundColor: C.surface,
  },
  // Borderless input inside inputRow (the border lives on inputRow).
  inputFlex: {
    flex: 1,
    height: '100%',
    fontSize: 18,
    color: C.text,
  },
  eyeButton: {
    padding: 8,
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
    borderRadius: radius.md,
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
