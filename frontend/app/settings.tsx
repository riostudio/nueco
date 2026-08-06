import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, StyleSheet, ScrollView, Linking, TouchableOpacity, Alert,
  Switch, Modal, TextInput, ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { MaterialIcons } from '@expo/vector-icons';
import { useRouter, useFocusEffect, type Href } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useAuth } from '../src/auth';
import { accountApi } from '../src/api';
import { isAnalyticsEnabled, setAnalyticsEnabled } from '../src/analytics';
import { isPersistPinned, setPersistPinned } from '../src/dailyBrew/dailyBrew';
import { clearLocalData } from '../src/offlineSync';
import { exportMyData } from '../src/dataExport';
import { BACKEND_BASE_URL } from '../src/backendBaseUrl';
import { ReminderVoicePicker } from '../src/components/ReminderVoicePicker';
import { C, radius, borderWidth } from '../src/theme';

// Served from the backend itself (same origin as the API) - see backend/server.py's
// GET /privacy route and backend/static/privacy.html. Swap to a nueco.app URL if
// that domain ever gets a custom-domain mapping to this Railway service.
const PRIVACY_POLICY_URL = `${BACKEND_BASE_URL}/privacy`;
const TERMS_OF_USE_URL = `${BACKEND_BASE_URL}/terms`;

export default function PrivacyDataScreen() {
  const router = useRouter();
  const { logout, user, updateUserName } = useAuth();
  const [analyticsOn, setAnalyticsOn] = useState(false);
  const dailyBrewFeatureOn = user?.daily_brew_enabled === true;
  const [dailyBrewPinned, setDailyBrewPinned] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [showDelete, setShowDelete] = useState(false);
  const [password, setPassword] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState('');
  const [showEditName, setShowEditName] = useState(false);
  const [nameInput, setNameInput] = useState('');
  const [savingName, setSavingName] = useState(false);
  const [nameError, setNameError] = useState('');

  useEffect(() => { isAnalyticsEnabled().then(setAnalyticsOn); }, []);
  useEffect(() => { if (user) isPersistPinned(user.id).then(setDailyBrewPinned); }, [user]);

  // Reminder voice lives entirely on-device (a chosen system voice), so its
  // preference is read straight from local storage rather than the user record.
  const [voiceRemindersOn, setVoiceRemindersOn] = useState(false);
  useFocusEffect(useCallback(() => {
    AsyncStorage.getItem('reminder_voice_pref').then(raw => {
      try { setVoiceRemindersOn(raw ? JSON.parse(raw)?.mode !== 'off' : false); } catch { setVoiceRemindersOn(false); }
    }).catch(() => {});
  }, []));

  const toggleVoiceReminders = useCallback(async (next: boolean) => {
    setVoiceRemindersOn(next);
    if (!next) {
      // Turning off keeps any recorded clip on disk - re-enabling shouldn't force them to record
      // again. Only the mode changes.
      await AsyncStorage.setItem('reminder_voice_pref', JSON.stringify({ mode: 'off' })).catch(() => {});
      return;
    }
    // Turning on reveals the picker inline below; the picker persists the real choice itself
    // once the user selects a mode, so nothing more to write here.
  }, []);

  const confirmEditName = useCallback(async () => {
    const trimmed = nameInput.trim();
    if (!trimmed) { setNameError('Name cannot be empty.'); return; }
    setSavingName(true);
    setNameError('');
    try {
      await updateUserName(trimmed);
      setShowEditName(false);
    } catch {
      setNameError('Couldn’t save your name. It’s unchanged for now.');
    } finally {
      setSavingName(false);
    }
  }, [nameInput, updateUserName]);

  const handleExport = useCallback(async () => {
    setExporting(true);
    try {
      await exportMyData(user);
    } catch {
      Alert.alert('Couldn’t put your file together', 'Have another go whenever.');
    } finally {
      setExporting(false);
    }
  }, [user]);

  const toggleAnalytics = useCallback(async (value: boolean) => {
    setAnalyticsOn(value);
    await setAnalyticsEnabled(value);
  }, []);

  const toggleDailyBrewPinned = useCallback(async (value: boolean) => {
    if (!user) return;
    setDailyBrewPinned(value);
    await setPersistPinned(user.id, value);
  }, [user]);

  const confirmDelete = useCallback(async () => {
    if (!password) { setDeleteError('Enter your password to confirm.'); return; }
    setDeleting(true);
    setDeleteError('');
    // deleteAccount is the one irrevocable step - it's the only call whose failure means the
    // password was actually wrong. clearLocalData/logout are best-effort local cleanup after
    // that; bundling all three under one catch used to misreport a post-delete 401 from logout
    // (its own session token is invalidated as part of the delete) as "Incorrect password" on
    // an account that had, in fact, already been successfully deleted.
    try {
      await accountApi.deleteAccount(password);
    } catch (e: any) {
      setDeleting(false);
      const msg = String(e?.message || '');
      setDeleteError(
        msg.includes('401') || msg.toLowerCase().includes('incorrect')
          ? 'Incorrect password.'
          : 'Couldn’t delete your account. Nothing has changed.',
      );
      return;
    }
    // Account is gone server-side - proceed regardless of local cleanup failures.
    try { await clearLocalData(); } catch {}
    try { await logout(); } catch {}
    router.replace('/welcome');
  }, [password, logout, router]);

  return (
    <SafeAreaView style={s.container} edges={['top']}>
      <View style={s.header}>
        <TouchableOpacity onPress={() => router.back()} style={s.backBtn}>
          <MaterialIcons name="arrow-back" size={28} color={C.textSec} />
        </TouchableOpacity>
        <Text style={s.headerTitle}>Data & Privacy</Text>
        <View style={{ width: 48 }} />
      </View>

      <ScrollView style={s.scroll} contentContainerStyle={s.scrollContent}>
        <View style={s.card}>
          <TouchableOpacity
            testID="edit-name-btn"
            style={s.row}
            onPress={() => { setNameInput(user?.name || ''); setNameError(''); setShowEditName(true); }}
          >
            <MaterialIcons name="badge" size={24} color={C.textSec} />
            <View style={{ flex: 1, marginLeft: 16 }}>
              <Text style={s.rowLabelPlain}>Name</Text>
              <Text style={s.rowSub}>{user?.name || '—'}</Text>
            </View>
            <MaterialIcons name="edit" size={20} color={C.borderSub} />
          </TouchableOpacity>

          <View style={s.divider} />

          <View style={s.row}>
            <MaterialIcons name="email" size={24} color={C.textSec} />
            <View style={{ flex: 1, marginLeft: 16 }}>
              <Text style={s.rowLabelPlain}>Email</Text>
              <Text style={s.rowSub}>{user?.email || '—'}</Text>
            </View>
          </View>

          <View style={s.divider} />

          <TouchableOpacity style={s.row} onPress={() => Linking.openURL(PRIVACY_POLICY_URL)}>
            <MaterialIcons name="privacy-tip" size={24} color={C.textSec} />
            <Text style={s.rowLabel}>Privacy Policy</Text>
            <MaterialIcons name="open-in-new" size={22} color={C.borderSub} />
          </TouchableOpacity>

          <View style={s.divider} />

          <TouchableOpacity style={s.row} onPress={() => Linking.openURL(TERMS_OF_USE_URL)}>
            <MaterialIcons name="gavel" size={24} color={C.textSec} />
            <Text style={s.rowLabel}>Terms of Use</Text>
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

          {dailyBrewFeatureOn && (
            <>
              <View style={s.row}>
                <MaterialIcons name="push-pin" size={24} color={C.textSec} />
                <View style={{ flex: 1, marginLeft: 16 }}>
                  <Text style={s.rowLabelPlain}>Keep Daily Brew pinned</Text>
                  <Text style={s.rowSub}>
                    Always show the card at the top of My Notes, instead of hiding it for the day
                    when you tap "Done for today".
                  </Text>
                </View>
                <Switch
                  value={dailyBrewPinned}
                  onValueChange={toggleDailyBrewPinned}
                  trackColor={{ false: C.borderSub, true: C.primary + '80' }}
                  thumbColor={dailyBrewPinned ? C.primary : '#f4f3f4'}
                />
              </View>

              <View style={s.divider} />
            </>
          )}

          <View style={s.row}>
            <MaterialIcons name="record-voice-over" size={24} color={C.textSec} />
            <View style={{ flex: 1, marginLeft: 16 }}>
              <Text style={s.rowLabelPlain}>Speak my reminders</Text>
              <Text style={s.rowSub}>
                Reminders are read aloud in a voice you choose. Works offline, and nothing
                is sent anywhere.
              </Text>
            </View>
            <Switch
              value={voiceRemindersOn}
              onValueChange={toggleVoiceReminders}
              trackColor={{ false: C.borderSub, true: C.primary + '80' }}
              thumbColor={voiceRemindersOn ? C.primary : '#f4f3f4'}
              testID="voice-reminders-toggle"
            />
          </View>

          {voiceRemindersOn && (
            <View style={s.inlinePicker}>
              <ReminderVoicePicker onModeChange={m => setVoiceRemindersOn(m !== 'off')} />
            </View>
          )}

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

        <View style={{ height: 40 }} />
      </ScrollView>

      {/* Edit name (correction/rectification right - APP 13, GDPR Art. 16) */}
      <Modal visible={showEditName} transparent animationType="fade" onRequestClose={() => !savingName && setShowEditName(false)}>
        <View style={s.modalOverlay}>
          <View style={s.modalContent}>
            <MaterialIcons name="badge" size={48} color={C.primary} style={{ marginBottom: 12 }} />
            <Text style={s.modalTitle}>Edit name</Text>
            <Text style={s.modalMessage}>This is the name shown on your account.</Text>
            <TextInput
              testID="edit-name-input"
              style={s.pwInput}
              placeholder="Your name"
              placeholderTextColor={C.borderSub}
              autoCapitalize="words"
              value={nameInput}
              onChangeText={setNameInput}
              editable={!savingName}
            />
            {nameError ? <Text style={s.errorText}>{nameError}</Text> : null}
            <View style={s.modalButtons}>
              <TouchableOpacity style={s.modalCancelBtn} onPress={() => setShowEditName(false)} disabled={savingName} activeOpacity={0.7}>
                <Text style={s.modalCancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity testID="save-name-btn" style={s.modalSaveBtn} onPress={confirmEditName} disabled={savingName} activeOpacity={0.7}>
                {savingName ? <ActivityIndicator color="#FFFFFF" size="small" /> : <Text style={s.modalDeleteText}>Save</Text>}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

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

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingTop: 12,
    paddingBottom: 12,
  },
  backBtn: { padding: 12 },
  headerTitle: { fontSize: 22, fontWeight: '700', color: C.text },
  scroll: { flex: 1 },
  scrollContent: { paddingHorizontal: 24, paddingTop: 8 },
  card: {
    backgroundColor: C.surface, padding: 20,
  },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10 },
  rowLabel: { fontSize: 18, color: C.text, marginLeft: 16, flex: 1, fontWeight: '500' },
  rowLabelPlain: { fontSize: 18, color: C.text },
  rowSub: { fontSize: 14, color: C.textSec, marginTop: 2 },
  inlinePicker: { paddingHorizontal: 16, paddingBottom: 8 },
  divider: { height: 1, backgroundColor: C.borderSub + '40', marginVertical: 4 },
  pwInput: {
    width: '100%', height: 52, borderWidth: borderWidth.thick, borderColor: C.borderSub, borderRadius: radius.md,
    paddingHorizontal: 16, fontSize: 18, color: C.text, backgroundColor: C.bg, marginBottom: 8,
  },
  errorText: { color: C.danger, fontSize: 14, alignSelf: 'flex-start', marginBottom: 8 },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', alignItems: 'center', padding: 24 },
  modalContent: { backgroundColor: C.surface, borderRadius: 20, padding: 24, width: '100%', maxWidth: 340, alignItems: 'center' },
  modalTitle: { fontSize: 22, fontWeight: '700', color: C.text, marginBottom: 12 },
  modalMessage: { fontSize: 16, color: C.textSec, textAlign: 'center', marginBottom: 24 },
  modalButtons: { flexDirection: 'row', gap: 12, width: '100%' },
  modalCancelBtn: { flex: 1, paddingVertical: 14, borderRadius: 12, backgroundColor: '#E0E0E0', alignItems: 'center' },
  modalCancelText: { fontSize: 16, fontWeight: '600', color: C.text },
  modalDeleteBtn: { flex: 1, paddingVertical: 14, borderRadius: 12, backgroundColor: C.danger, alignItems: 'center' },
  modalDeleteText: { fontSize: 16, fontWeight: '600', color: '#FFFFFF' },
  modalSaveBtn: { flex: 1, paddingVertical: 14, borderRadius: 12, backgroundColor: C.primary, alignItems: 'center' },
});
