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
  selected: '#E8F5E9',
  selectedBorder: '#4CAF50',
};

interface LinkAccountBottomSheetProps {
  isVisible: boolean;
  onDismiss: () => void;
  onSuccess?: () => void;
}

type ContactMethod = 'email' | 'mobile';

export function LinkAccountBottomSheet({
  isVisible,
  onDismiss,
  onSuccess,
}: LinkAccountBottomSheetProps) {
  const bottomSheetRef = useRef<BottomSheet>(null);
  const snapPoints = useMemo(() => ['70%'], []);
  const [contactMethod, setContactMethod] = useState<ContactMethod>('email');
  const [email, setEmail] = useState('');
  const [mobile, setMobile] = useState('');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<{ contact?: string; password?: string }>({});
  const { linkAccount, isLoading } = useLinkAccount();

  const validateEmail = (email: string): boolean => {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
  };

  const validateMobile = (mobile: string): boolean => {
    // Allow digits, spaces, dashes, parentheses, and + for international
    const mobileRegex = /^[\d\s\-\(\)\+]{8,}$/;
    return mobileRegex.test(mobile);
  };

  const handleSave = useCallback(async () => {
    const newErrors: { contact?: string; password?: string } = {};

    // Validate contact method
    if (contactMethod === 'email') {
      if (!email.trim()) {
        newErrors.contact = strings.errorEmailRequired;
      } else if (!validateEmail(email.trim())) {
        newErrors.contact = strings.errorInvalidEmail;
      }
    } else {
      if (!mobile.trim()) {
        newErrors.contact = strings.errorMobileRequired;
      } else if (!validateMobile(mobile.trim())) {
        newErrors.contact = strings.errorInvalidMobile;
      }
    }

    // Validate password
    if (!password.trim()) {
      newErrors.password = strings.errorPasswordRequired;
    } else if (password.trim().length < 6) {
      newErrors.password = strings.errorPasswordTooShort;
    }

    setErrors(newErrors);
    if (Object.keys(newErrors).length > 0) return;

    const result = await linkAccount(
      contactMethod === 'email' ? email.trim() : undefined,
      contactMethod === 'mobile' ? mobile.trim() : undefined,
      password.trim()
    );

    if (result.success) {
      onSuccess?.();
      onDismiss();
    } else {
      setErrors({ contact: result.error });
    }
  }, [contactMethod, email, mobile, password, linkAccount, onDismiss, onSuccess]);

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
        <Text style={styles.subheading}>{strings.linkAccountSubheading}</Text>

        {/* Contact Method Selector */}
        <Text style={styles.label}>{strings.labelChooseContact}</Text>
        <View style={styles.toggleRow}>
          <TouchableOpacity
            style={[
              styles.toggleButton,
              contactMethod === 'email' && styles.toggleButtonSelected,
            ]}
            onPress={() => setContactMethod('email')}
          >
            <Text
              style={[
                styles.toggleText,
                contactMethod === 'email' && styles.toggleTextSelected,
              ]}
            >
              {strings.labelEmail}
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[
              styles.toggleButton,
              contactMethod === 'mobile' && styles.toggleButtonSelected,
            ]}
            onPress={() => setContactMethod('mobile')}
          >
            <Text
              style={[
                styles.toggleText,
                contactMethod === 'mobile' && styles.toggleTextSelected,
              ]}
            >
              {strings.labelMobile}
            </Text>
          </TouchableOpacity>
        </View>

        {/* Contact Input */}
        {contactMethod === 'email' ? (
          <TextInput
            style={[styles.input, errors.contact && styles.inputError]}
            placeholder={strings.hintEmailRequired}
            placeholderTextColor={C.borderSub}
            keyboardType="email-address"
            autoCapitalize="none"
            value={email}
            onChangeText={(text) => {
              setEmail(text);
              if (errors.contact) setErrors((e) => ({ ...e, contact: undefined }));
            }}
          />
        ) : (
          <TextInput
            style={[styles.input, errors.contact && styles.inputError]}
            placeholder={strings.hintMobileRequired}
            placeholderTextColor={C.borderSub}
            keyboardType="phone-pad"
            value={mobile}
            onChangeText={(text) => {
              setMobile(text);
              if (errors.contact) setErrors((e) => ({ ...e, contact: undefined }));
            }}
          />
        )}
        {errors.contact && <Text style={styles.errorText}>{errors.contact}</Text>}

        {/* Password Input */}
        <Text style={styles.label}>{strings.labelPassword}</Text>
        <TextInput
          style={[styles.input, errors.password && styles.inputError]}
          placeholder={strings.hintPasswordRequired}
          placeholderTextColor={C.borderSub}
          secureTextEntry
          value={password}
          onChangeText={(text) => {
            setPassword(text);
            if (errors.password) setErrors((e) => ({ ...e, password: undefined }));
          }}
        />
        {errors.password && <Text style={styles.errorText}>{errors.password}</Text>}

        <TouchableOpacity
          style={styles.saveButton}
          onPress={handleSave}
          disabled={isLoading}
        >
          {isLoading ? (
            <ActivityIndicator color={C.primaryFg} />
          ) : (
            <Text style={styles.saveButtonText}>{strings.btnCreateAccount}</Text>
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
    marginBottom: 8,
    textAlign: 'center',
  },
  subheading: {
    fontSize: 16,
    color: C.textSec,
    marginBottom: 20,
    textAlign: 'center',
  },
  label: {
    fontSize: 16,
    fontWeight: '600',
    color: C.text,
    marginBottom: 8,
  },
  toggleRow: {
    flexDirection: 'row',
    marginBottom: 16,
    gap: 12,
  },
  toggleButton: {
    flex: 1,
    height: 48,
    borderWidth: 2,
    borderColor: C.border,
    borderRadius: 12,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: C.bg,
  },
  toggleButtonSelected: {
    borderColor: C.selectedBorder,
    backgroundColor: C.selected,
  },
  toggleText: {
    fontSize: 18,
    fontWeight: '600',
    color: C.textSec,
  },
  toggleTextSelected: {
    color: C.selectedBorder,
  },
  input: {
    height: 56,
    borderWidth: 2,
    borderColor: C.border,
    borderRadius: 12,
    paddingHorizontal: 16,
    fontSize: 18,
    color: C.text,
    marginBottom: 8,
    backgroundColor: C.bg,
  },
  inputError: {
    borderColor: C.error,
  },
  errorText: {
    color: C.error,
    fontSize: 14,
    marginBottom: 12,
  },
  saveButton: {
    backgroundColor: C.primary,
    height: 56,
    borderRadius: 12,
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: 16,
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
