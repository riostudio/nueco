import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, StyleSheet, ScrollView, Linking, TouchableOpacity, Alert, Platform,
  Switch, Modal, TextInput, ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { MaterialIcons } from '@expo/vector-icons';
import * as SecureStore from 'expo-secure-store';
import { useRouter } from 'expo-router';
import { UserAvatar, useAuth } from '../../src/auth';
import { accountApi } from '../../src/api';
import { isAnalyticsEnabled, setAnalyticsEnabled } from '../../src/analytics';
import { clearLocalData } from '../../src/offlineSync';
import { exportMyData } from '../../src/dataExport';

// TODO: replace with your real hosted privacy policy URL.
const PRIVACY_POLICY_URL = 'https://memopad.app/privacy';

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
  danger: '#C62828',
};

export default function SettingsScreen() {
  const router = useRouter();
  const { logout, user } = useAuth();
  const [analyticsOn, setAnalyticsOn] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [showDelete, setShowDelete] = useState(false);
  const [password, setPassword] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState('');

  useEffect(() => { isAnalyticsEnabled().then(setAnalyticsOn); }, []);

  const handleExport = useCallback(async () => {
    setExporting(true);
    try {
      await exportMyData(user);
    } catch {
      Alert.alert('Export failed', 'Could not export your data. Please try again.');
    } finally {
      setExporting(false);
    }
  }, [user]);

  const toggleAnalytics = useCallback(async (value: boolean) => {
    setAnalyticsOn(value);
    await setAnalyticsEnabled(value);
  }, []);

  const confirmDelete = useCallback(async () => {
    if (!password) { setDeleteError('Enter your password to confirm.'); return; }
    setDeleting(true);
    setDeleteError('');
    try {
      await accountApi.deleteAccount(password);
      await clearLocalData();
      await logout();
      router.replace('/welcome');
    } catch (e: any) {
      setDeleting(false);
      const msg = String(e?.message || '');
      setDeleteError(
        msg.includes('401') || msg.toLowerCase().includes('incorrect')
          ? 'Incorrect password.'
          : 'Could not delete account. Please try again.',
      );
    }
  }, [password, logout, router]);

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

        <View style={s.section}>
          <Text style={s.sectionTitle}>Privacy & Data</Text>
          <View style={s.card}>
            <TouchableOpacity style={s.row} onPress={() => Linking.openURL(PRIVACY_POLICY_URL)}>
              <MaterialIcons name="privacy-tip" size={24} color={C.textSec} />
              <Text style={s.rowLabel}>Privacy Policy</Text>
              <MaterialIcons name="open-in-new" size={22} color={C.borderSub} />
            </TouchableOpacity>
            <View style={s.divider} />
            <View style={s.row}>
              <MaterialIcons name="insights" size={24} color={C.textSec} />
              <View style={{ flex: 1, marginLeft: 16 }}>
                <Text style={s.rowLabelPlain}>Usage analytics</Text>
                <Text style={s.rowSub}>Anonymous usage data to improve the app.</Text>
              </View>
              <Switch
                value={analyticsOn}
                onValueChange={toggleAnalytics}
                trackColor={{ false: C.borderSub, true: C.primary + '80' }}
                thumbColor={analyticsOn ? C.primary : '#f4f3f4'}
              />
            </View>
            <View style={s.divider} />
            <TouchableOpacity testID="export-data-btn" style={s.row} onPress={handleExport} disabled={exporting}>
              <MaterialIcons name="download" size={24} color={C.textSec} />
              <Text style={s.rowLabel}>Export my data</Text>
              {exporting
                ? <ActivityIndicator size="small" color={C.textSec} />
                : <MaterialIcons name="chevron-right" size={22} color={C.borderSub} />}
            </TouchableOpacity>
            <View style={s.divider} />
            <TouchableOpacity
              testID="delete-account-btn"
              style={s.row}
              onPress={() => { setPassword(''); setDeleteError(''); setShowDelete(true); }}
            >
              <MaterialIcons name="delete-forever" size={24} color={C.danger} />
              <Text style={[s.rowLabel, { color: C.danger }]}>Delete account</Text>
              <MaterialIcons name="chevron-right" size={22} color={C.borderSub} />
            </TouchableOpacity>
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

      {/* Delete-account confirmation (GDPR right to erasure) */}
      <Modal visible={showDelete} transparent animationType="fade" onRequestClose={() => !deleting && setShowDelete(false)}>
        <View style={s.modalOverlay}>
          <View style={s.modalContent}>
            <MaterialIcons name="warning" size={48} color={C.danger} style={{ marginBottom: 12 }} />
            <Text style={s.modalTitle}>Delete account?</Text>
            <Text style={s.modalMessage}>
              This permanently erases your account and all your notes, events, and files. It can’t be undone. Enter your password to confirm.
            </Text>
            <TextInput
              testID="delete-password-input"
              style={s.pwInput}
              placeholder="Password"
              placeholderTextColor={C.borderSub}
              secureTextEntry
              autoCapitalize="none"
              value={password}
              onChangeText={setPassword}
              editable={!deleting}
            />
            {deleteError ? <Text style={s.errorText}>{deleteError}</Text> : null}
            <View style={s.modalButtons}>
              <TouchableOpacity style={s.modalCancelBtn} onPress={() => setShowDelete(false)} disabled={deleting} activeOpacity={0.7}>
                <Text style={s.modalCancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity style={s.modalDeleteBtn} onPress={confirmDelete} disabled={deleting} activeOpacity={0.7}>
                {deleting ? <ActivityIndicator color="#FFFFFF" size="small" /> : <Text style={s.modalDeleteText}>Delete</Text>}
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
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10 },
  rowLabel: { fontSize: 18, color: C.text, marginLeft: 16, flex: 1, fontWeight: '500' },
  rowLabelPlain: { fontSize: 18, color: C.text },
  rowSub: { fontSize: 14, color: C.textSec, marginTop: 2 },
  divider: { height: 1, backgroundColor: C.borderSub + '40', marginVertical: 4 },
  pwInput: {
    width: '100%', height: 52, borderWidth: 2, borderColor: C.borderSub, borderRadius: 12,
    paddingHorizontal: 16, fontSize: 18, color: C.text, backgroundColor: C.bg, marginBottom: 8,
  },
  errorText: { color: C.danger, fontSize: 14, alignSelf: 'flex-start', marginBottom: 8 },
  modalDeleteBtn: { flex: 1, paddingVertical: 14, borderRadius: 12, backgroundColor: C.danger, alignItems: 'center' },
  modalDeleteText: { fontSize: 16, fontWeight: '600', color: '#FFFFFF' },
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
