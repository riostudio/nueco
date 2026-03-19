import React, { useState, useEffect } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { User } from '../types/auth.types';
import { strings } from '../constants/strings';
import { authStorage } from '../storage/authStorage';

const C = {
  warning: '#FFF3E0',
  warningText: '#E65100',
  primary: '#D84315',
};

interface EmailVerificationBannerProps {
  user: User | null;
  onResend: () => void;
}

export function EmailVerificationBanner({
  user,
  onResend,
}: EmailVerificationBannerProps) {
  const [firstNoteSaved, setFirstNoteSaved] = useState(false);

  useEffect(() => {
    const checkFirstNote = async () => {
      const saved = await authStorage.isFirstNoteSaved();
      setFirstNoteSaved(saved);
    };
    checkFirstNote();
  }, [user]);

  // Only show if:
  // 1. User has signed up (first note was saved)
  // 2. User has email
  // 3. Email is not yet verified
  if (!firstNoteSaved || !user || !user.email || user.email_verified) {
    return null;
  }

  return (
    <View style={styles.banner}>
      <Text style={styles.bannerText}>{strings.bannerVerifyEmail}</Text>
      <TouchableOpacity onPress={onResend}>
        <Text style={styles.resendText}>{strings.bannerResend}</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    flexDirection: 'row',
    backgroundColor: C.warning,
    paddingHorizontal: 16,
    paddingVertical: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  bannerText: {
    fontSize: 16,
    color: C.warningText,
    marginRight: 8,
  },
  resendText: {
    fontSize: 16,
    color: C.primary,
    fontWeight: '600',
    textDecorationLine: 'underline',
  },
});
