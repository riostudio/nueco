import React, { useState } from 'react';
import { View, Text, StyleSheet, ScrollView, Linking, TouchableOpacity, Modal, Alert, Platform } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { MaterialIcons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import * as SecureStore from 'expo-secure-store';
import { UserAvatar, useAuth } from '../../src/auth';

const C = {
  primary: '#D84315',
  primaryFg: '#FFFFFF',
  bg: '#FDFBF7',
  surface: '#FFFFFF',
  text: '#121212',
  textSec: '#37474F',
  border: '#121212',
  borderSub: '#78909C',
  success: '#2E7D32',
};

export default function SettingsScreen() {
  const router = useRouter();
  const { user, logout } = useAuth();
  const [logoutModalVisible, setLogoutModalVisible] = useState(false);

  const handleLogout = async () => {
    await logout();
    setLogoutModalVisible(false);
    router.replace('/welcome');
  };

  return (
    <SafeAreaView style={s.container} edges={['top']}>
      <View style={s.header}>
        <Text style={s.headerTitle}>Settings</Text>
        <UserAvatar size={36} />
      </View>

      <ScrollView style={s.scroll} contentContainerStyle={s.scrollContent}>
        <View style={s.section}>
          <Text style={s.sectionTitle}>About MemoPad</Text>
          <View style={s.card}>
            <View style={s.aboutRow}>
              <View style={s.iconCircle}>
                <MaterialIcons name="description" size={32} color={C.primaryFg} />
              </View>
              <View style={s.aboutInfo}>
                <Text style={s.appName}>MemoPad</Text>
                <Text style={s.appVersion}>Version 1.0.0</Text>
              </View>
            </View>
            <Text style={s.aboutDesc}>
              A simple, accessible note-taking app with large text, clear actions, and voice input that makes it easy for everyone.
            </Text>
          </View>
        </View>

        <View style={s.section}>
          <Text style={s.sectionTitle}>Features</Text>
          <View style={s.card}>
            <FeatureItem icon="edit" label="Create & organize notes with tags" />
            <FeatureItem icon="push-pin" label="Pin important notes to the top" />
            <FeatureItem icon="mic" label="Voice input for hands-free notes" />
            <FeatureItem icon="calendar-today" label="Calendar integration & scheduling" />
            <FeatureItem icon="search" label="Search across all your notes" />
            <FeatureItem icon="format-bold" label="Basic text formatting" />
          </View>
        </View>

        <View style={s.section}>
          <Text style={s.sectionTitle}>Accessibility</Text>
          <View style={s.card}>
            <Text style={s.accessText}>
              MemoPad is designed for accessibility with:
            </Text>
            <Text style={s.accessItem}>
              {'\u2022'} Large fonts (18pt minimum)
            </Text>
            <Text style={s.accessItem}>
              {'\u2022'} High contrast (WCAG AAA compliant)
            </Text>
            <Text style={s.accessItem}>
              {'\u2022'} Large touch targets (56px minimum)
            </Text>
            <Text style={s.accessItem}>
              {'\u2022'} No hidden gestures
            </Text>
            <Text style={s.accessItem}>
              {'\u2022'} Voice input support
            </Text>
          </View>
        </View>

        <View style={s.section}>
          <Text style={s.sectionTitle}>Tips</Text>
          <View style={s.card}>
            <Text style={s.tipText}>
              {'\u2022'} <Text style={s.tipBold}>Bold text:</Text> Tap the B button in the editor
            </Text>
            <Text style={s.tipText}>
              {'\u2022'} <Text style={s.tipBold}>Italic text:</Text> Tap the I button in the editor
            </Text>
            <Text style={s.tipText}>
              {'\u2022'} <Text style={s.tipBold}>Bullet lists:</Text> Tap the list button in the editor
            </Text>
            <Text style={s.tipText}>
              {'\u2022'} <Text style={s.tipBold}>Voice input:</Text> Tap the microphone button at the bottom of the editor
            </Text>
            <Text style={s.tipText}>
              {'\u2022'} <Text style={s.tipBold}>Pin a note:</Text> Tap the pin icon on any note card
            </Text>
          </View>
        </View>

        {__DEV__ && Platform.OS !== 'web' && (
          <View style={s.section}>
            <Text style={s.sectionTitle}>Debug (dev only)</Text>
            <View style={s.card}>
              <Text style={s.aboutDesc}>
                Simulates the OS evicting the cached user object from SecureStore while leaving tokens intact. Tap, then reload the app (shake device → Reload) to verify the session and notes recover without a fresh login.
              </Text>
              <TouchableOpacity
                style={[s.modalLogoutBtn, { marginTop: 16 }]}
                onPress={async () => {
                  await SecureStore.deleteItemAsync('user_data');
                  Alert.alert('Done', 'Cached user cleared. Now reload the app to test recovery.');
                }}
              >
                <Text style={s.modalLogoutText}>Simulate cache eviction</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}

        <View style={{ height: 40 }} />
      </ScrollView>

      {/* Logout Confirmation Modal */}
      <Modal
        visible={logoutModalVisible}
        transparent={true}
        animationType="fade"
        onRequestClose={() => setLogoutModalVisible(false)}
      >
        <View style={s.modalOverlay}>
          <View style={s.modalContent}>
            <MaterialIcons name="logout" size={48} color={C.primary} style={{ marginBottom: 16 }} />
            <Text style={s.modalTitle}>Log Out?</Text>
            <Text style={s.modalMessage}>Are you sure you want to log out?</Text>
            <View style={s.modalButtons}>
              <TouchableOpacity style={s.modalCancelBtn} onPress={() => setLogoutModalVisible(false)}>
                <Text style={s.modalCancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity style={s.modalLogoutBtn} onPress={handleLogout}>
                <Text style={s.modalLogoutText}>Log Out</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

function FeatureItem({ icon, label }: { icon: string; label: string }) {
  return (
    <View style={s.featureRow}>
      <MaterialIcons name={icon as any} size={24} color={C.success} />
      <Text style={s.featureLabel}>{label}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg },
  header: { 
    flexDirection: 'row', 
    justifyContent: 'space-between', 
    alignItems: 'center',
    paddingHorizontal: 24, 
    paddingTop: 12, 
    paddingBottom: 12 
  },
  headerTitle: { fontSize: 34, fontWeight: '700', color: C.text },
  scroll: { flex: 1 },
  scrollContent: { paddingHorizontal: 24 },
  section: { marginBottom: 24 },
  sectionTitle: { fontSize: 22, fontWeight: '600', color: C.textSec, marginBottom: 12 },
  card: {
    backgroundColor: C.surface, borderRadius: 12, padding: 20,
    borderWidth: 2, borderColor: C.borderSub,
  },
  aboutRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 16 },
  iconCircle: {
    width: 56, height: 56, borderRadius: 28, backgroundColor: C.primary,
    justifyContent: 'center', alignItems: 'center',
  },
  aboutInfo: { marginLeft: 16 },
  appName: { fontSize: 24, fontWeight: '700', color: C.text },
  appVersion: { fontSize: 18, color: C.textSec, marginTop: 2 },
  aboutDesc: { fontSize: 18, color: C.textSec, lineHeight: 26 },
  featureRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 8 },
  featureLabel: { fontSize: 18, color: C.text, marginLeft: 16, flex: 1 },
  accessText: { fontSize: 18, color: C.text, marginBottom: 8 },
  accessItem: { fontSize: 18, color: C.textSec, lineHeight: 28, paddingLeft: 8 },
  tipText: { fontSize: 18, color: C.textSec, lineHeight: 28, paddingLeft: 8 },
  tipBold: { fontWeight: '700', color: C.text },
  // Modal styles
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', alignItems: 'center', padding: 24 },
  modalContent: { backgroundColor: C.surface, borderRadius: 20, padding: 24, width: '100%', maxWidth: 340, alignItems: 'center' },
  modalTitle: { fontSize: 22, fontWeight: '700', color: C.text, marginBottom: 12 },
  modalMessage: { fontSize: 16, color: C.textSec, textAlign: 'center', marginBottom: 24 },
  modalButtons: { flexDirection: 'row', gap: 12, width: '100%' },
  modalCancelBtn: { flex: 1, paddingVertical: 14, borderRadius: 12, backgroundColor: '#E0E0E0', alignItems: 'center' },
  modalCancelText: { fontSize: 16, fontWeight: '600', color: C.text },
  modalLogoutBtn: { flex: 1, paddingVertical: 14, borderRadius: 12, backgroundColor: C.primary, alignItems: 'center' },
  modalLogoutText: { fontSize: 16, fontWeight: '600', color: '#FFFFFF' },
});
