import React, { useState, useCallback, useMemo, useRef } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
} from 'react-native';
import BottomSheet, { BottomSheetView } from '@gorhom/bottom-sheet';
import { useLinkAccount } from '../hooks/useLinkAccount';
import { authStorage } from '../storage/authStorage';
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

interface LinkAccountBottomSheetProps {
  isVisible: boolean;
  onDismiss: () => void;
  onSuccess?: () => void;
}

export function LinkAccountBottomSheet({
  isVisible,
  onDismiss,
  onSuccess,
}: LinkAccountBottomSheetProps) {
  const bottomSheetRef = useRef<BottomSheet>(null);
  const snapPoints = useMemo(() => ['60%'], []);
  const [email, setEmail] = useState('');
  const [mobile, setMobile] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const { linkAccount, isLoading } = useLinkAccount();

  const handleSave = useCallback(async () => {
    setError('');
    if (!email.trim() && !mobile.trim() && !password.trim()) {
      setError(strings.errorFillOneField);
      return;
    }

    const result = await linkAccount(
      email.trim() || undefined,
      mobile.trim() || undefined,
      password.trim() || undefined
    );

    if (result.success) {
      onSuccess?.();
      onDismiss();
    } else {
      setError(result.error);
    }
  }, [email, mobile, password, linkAccount, onDismiss, onSuccess]);

  const handleMaybeLater = useCallback(async () => {
    await authStorage.dismissModal();
    onDismiss();
  }, [onDismiss]);

  const handleSheetChanges = useCallback(
    (index: number) => {
      if (index === -1) {
        onDismiss();
      }
    },
    [onDismiss]
  );

  if (!isVisible) return null;

  return (
    <BottomSheet
      ref={bottomSheetRef}
      index={0}
      snapPoints={snapPoints}
      onChange={handleSheetChanges}
      enablePanDownToClose
      backgroundStyle={styles.sheetBackground}
      handleIndicatorStyle={styles.handleIndicator}
    >
      <BottomSheetView style={styles.container}>
        <Text style={styles.heading}>{strings.linkAccountHeading}</Text>

        <TextInput
          style={styles.input}
          placeholder={strings.hintEmail}
          placeholderTextColor={C.borderSub}
          keyboardType="email-address"
          autoCapitalize="none"
          value={email}
          onChangeText={setEmail}
        />

        <TextInput
          style={styles.input}
          placeholder={strings.hintMobile}
          placeholderTextColor={C.borderSub}
          keyboardType="phone-pad"
          value={mobile}
          onChangeText={setMobile}
        />

        <TextInput
          style={styles.input}
          placeholder={strings.hintPassword}
          placeholderTextColor={C.borderSub}
          secureTextEntry
          value={password}
          onChangeText={setPassword}
        />

        {error ? <Text style={styles.errorText}>{error}</Text> : null}

        <TouchableOpacity
          style={styles.saveButton}
          onPress={handleSave}
          disabled={isLoading}
        >
          {isLoading ? (
            <ActivityIndicator color={C.primaryFg} />
          ) : (
            <Text style={styles.saveButtonText}>{strings.btnSave}</Text>
          )}
        </TouchableOpacity>

        <TouchableOpacity onPress={handleMaybeLater} style={styles.laterButton}>
          <Text style={styles.laterText}>{strings.btnMaybeLater}</Text>
        </TouchableOpacity>
      </BottomSheetView>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  sheetBackground: {
    backgroundColor: C.surface,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
  },
  handleIndicator: {
    backgroundColor: C.borderSub,
    width: 40,
  },
  container: {
    flex: 1,
    padding: 24,
  },
  heading: {
    fontSize: 24,
    fontWeight: '700',
    color: C.text,
    marginBottom: 24,
    textAlign: 'center',
  },
  input: {
    height: 56,
    borderWidth: 2,
    borderColor: C.border,
    borderRadius: 12,
    paddingHorizontal: 16,
    fontSize: 18,
    color: C.text,
    marginBottom: 16,
    backgroundColor: C.bg,
  },
  errorText: {
    color: C.error,
    fontSize: 16,
    marginBottom: 16,
    textAlign: 'center',
  },
  saveButton: {
    backgroundColor: C.primary,
    height: 56,
    borderRadius: 12,
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: 8,
  },
  saveButtonText: {
    color: C.primaryFg,
    fontSize: 20,
    fontWeight: '600',
  },
  laterButton: {
    marginTop: 16,
    alignItems: 'center',
  },
  laterText: {
    color: C.primary,
    fontSize: 18,
    textDecorationLine: 'underline',
  },
});
