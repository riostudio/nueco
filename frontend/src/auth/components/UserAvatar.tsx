import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import { User } from '../types/auth.types';

const C = {
  primary: '#D84315',
  primaryFg: '#FFFFFF',
  success: '#4CAF50',
  successFg: '#FFFFFF',
  text: '#121212',
  borderSub: '#78909C',
};

interface UserAvatarProps {
  user: User | null;
  size?: number;
}

export function UserAvatar({ user, size = 40 }: UserAvatarProps) {
  const router = useRouter();

  // Only show if user has verified email
  if (!user || !user.email || !user.email_verified) {
    return null;
  }

  const firstLetter = user.email.charAt(0).toUpperCase();

  const handlePress = () => {
    router.push('/change-password');
  };

  return (
    <TouchableOpacity
      onPress={handlePress}
      style={[
        styles.avatar,
        {
          width: size,
          height: size,
          borderRadius: size / 2,
        },
      ]}
    >
      <Text style={[styles.letter, { fontSize: size * 0.5 }]}>{firstLetter}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  avatar: {
    backgroundColor: C.success,
    justifyContent: 'center',
    alignItems: 'center',
  },
  letter: {
    color: C.successFg,
    fontWeight: '700',
  },
});
