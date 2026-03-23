import React, { useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Modal, Pressable } from 'react-native';
import { useRouter } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { User } from '../types/auth.types';
import { useAuth } from '../context/AuthContext';

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
};

interface UserAvatarProps {
  size?: number;
}

export function UserAvatar({ size = 40 }: UserAvatarProps) {
  const router = useRouter();
  const { user, logout } = useAuth();
  const [menuVisible, setMenuVisible] = useState(false);

  if (!user) return null;

  const firstLetter = user.email.charAt(0).toUpperCase();

  const handleChangePassword = () => {
    setMenuVisible(false);
    router.push('/change-password');
  };

  const handleLogout = async () => {
    setMenuVisible(false);
    await logout();
    router.replace('/welcome');
  };

  return (
    <>
      <TouchableOpacity
        onPress={() => setMenuVisible(true)}
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

      <Modal
        visible={menuVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setMenuVisible(false)}
      >
        <Pressable style={styles.modalOverlay} onPress={() => setMenuVisible(false)}>
          <View style={styles.menuContainer}>
            <View style={styles.menuHeader}>
              <View style={styles.menuAvatar}>
                <Text style={styles.menuAvatarText}>{firstLetter}</Text>
              </View>
              <View style={styles.menuUserInfo}>
                <Text style={styles.menuUserName}>{user.name}</Text>
                <Text style={styles.menuUserEmail}>{user.email}</Text>
              </View>
            </View>
            
            <View style={styles.menuDivider} />
            
            <TouchableOpacity style={styles.menuItem} onPress={handleChangePassword}>
              <MaterialIcons name="lock" size={24} color={C.text} />
              <Text style={styles.menuText}>Change Password</Text>
            </TouchableOpacity>
            
            <TouchableOpacity style={styles.menuItem} onPress={handleLogout}>
              <MaterialIcons name="logout" size={24} color={C.primary} />
              <Text style={[styles.menuText, { color: C.primary }]}>Log Out</Text>
            </TouchableOpacity>
          </View>
        </Pressable>
      </Modal>
    </>
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
    borderRadius: 16,
    paddingVertical: 16,
    minWidth: 260,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.15,
    shadowRadius: 12,
    elevation: 8,
  },
  menuHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingBottom: 16,
  },
  menuAvatar: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: C.success,
    justifyContent: 'center',
    alignItems: 'center',
  },
  menuAvatarText: {
    color: C.successFg,
    fontSize: 22,
    fontWeight: '700',
  },
  menuUserInfo: {
    marginLeft: 12,
    flex: 1,
  },
  menuUserName: {
    fontSize: 18,
    fontWeight: '600',
    color: C.text,
  },
  menuUserEmail: {
    fontSize: 14,
    color: C.textSec,
    marginTop: 2,
  },
  menuDivider: {
    height: 1,
    backgroundColor: C.borderSub + '30',
    marginVertical: 8,
  },
  menuItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 14,
    gap: 12,
  },
  menuText: {
    fontSize: 17,
    fontWeight: '500',
    color: C.text,
  },
});
