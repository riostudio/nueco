import React, { useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Modal, Pressable } from 'react-native';
import { useRouter } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { User } from '../types/auth.types';

const C = {
  primary: '#D84315',
  primaryFg: '#FFFFFF',
  success: '#4CAF50',
  successFg: '#FFFFFF',
  text: '#121212',
  textSec: '#37474F',
  borderSub: '#78909C',
  surface: '#FFFFFF',
  bg: '#FDFBF7',
  defaultAvatar: '#9E9E9E',
};

interface UserAvatarProps {
  user: User | null;
  size?: number;
  onSignInPress?: () => void;
  onLogout?: () => void;
}

export function UserAvatar({ user, size = 40, onSignInPress, onLogout }: UserAvatarProps) {
  const router = useRouter();
  const [menuVisible, setMenuVisible] = useState(false);

  // Check if user is verified (email_verified OR mobile_verified)
  const isVerified = user?.email_verified || user?.mobile_verified;
  
  // Get first letter - prefer email, fallback to mobile number first digit, then phone icon
  const getDisplayLetter = () => {
    if (user?.email && user?.email_verified) {
      return user.email.charAt(0).toUpperCase();
    }
    if (user?.mobile_number && user?.mobile_verified) {
      // Return phone icon indicator for mobile-verified users
      return null; // Will show phone icon instead
    }
    return '';
  };
  
  const firstLetter = getDisplayLetter();
  const showPhoneIcon = isVerified && !firstLetter && user?.mobile_verified;

  const handlePress = () => {
    setMenuVisible(true);
  };

  const handleChangePassword = () => {
    setMenuVisible(false);
    router.push('/change-password');
  };

  const handleLogout = () => {
    setMenuVisible(false);
    onLogout?.();
  };

  const handleSignIn = () => {
    setMenuVisible(false);
    onSignInPress?.();
  };

  return (
    <>
      <TouchableOpacity
        onPress={handlePress}
        style={[
          styles.avatar,
          {
            width: size,
            height: size,
            borderRadius: size / 2,
            backgroundColor: isVerified ? C.success : C.defaultAvatar,
          },
        ]}
      >
        {isVerified ? (
          showPhoneIcon ? (
            <MaterialIcons name="phone" size={size * 0.5} color={C.surface} />
          ) : (
            <Text style={[styles.letter, { fontSize: size * 0.5 }]}>{firstLetter}</Text>
          )
        ) : (
          <MaterialIcons name="person" size={size * 0.6} color={C.surface} />
        )}
      </TouchableOpacity>

      <Modal
        visible={menuVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setMenuVisible(false)}
      >
        <Pressable style={styles.modalOverlay} onPress={() => setMenuVisible(false)}>
          <View style={styles.menuContainer}>
            {isVerified ? (
              // Signed in menu
              <>
                <TouchableOpacity style={styles.menuItem} onPress={handleChangePassword}>
                  <MaterialIcons name="lock" size={24} color={C.text} />
                  <Text style={styles.menuText}>Change Password</Text>
                </TouchableOpacity>
                <View style={styles.menuDivider} />
                <TouchableOpacity style={styles.menuItem} onPress={handleLogout}>
                  <MaterialIcons name="logout" size={24} color={C.primary} />
                  <Text style={[styles.menuText, { color: C.primary }]}>Log out</Text>
                </TouchableOpacity>
              </>
            ) : (
              // Signed out menu
              <TouchableOpacity style={styles.menuItem} onPress={handleSignIn}>
                <MaterialIcons name="login" size={24} color={C.success} />
                <Text style={[styles.menuText, { color: C.success }]}>Sign In</Text>
              </TouchableOpacity>
            )}
          </View>
        </Pressable>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  avatar: {
    justifyContent: 'center',
    alignItems: 'center',
  },
  letter: {
    color: C.successFg,
    fontWeight: '700',
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.3)',
    justifyContent: 'flex-start',
    alignItems: 'flex-end',
    paddingTop: 100,
    paddingRight: 16,
  },
  menuContainer: {
    backgroundColor: C.surface,
    borderRadius: 12,
    paddingVertical: 8,
    minWidth: 200,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.25,
    shadowRadius: 8,
    elevation: 5,
  },
  menuItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 14,
    gap: 12,
  },
  menuText: {
    fontSize: 18,
    fontWeight: '600',
    color: C.text,
  },
  menuDivider: {
    height: 1,
    backgroundColor: C.borderSub + '40',
    marginHorizontal: 16,
  },
});
