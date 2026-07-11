/**
 * Connect/disconnect a Canva account for importing designs into notes (see canva-picker.tsx).
 * The OAuth handshake itself lives entirely on the backend (backend/canva/) - this screen only
 * ever talks to our own API, never to Canva directly, and never sees a Canva token.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator, Alert } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { MaterialIcons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { canvaApi } from '../src/api';
import { C } from '../src/theme';

function formatConnectedAt(iso?: string | null): string {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
  } catch {
    return '';
  }
}

export default function CanvaSettingsScreen() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [connected, setConnected] = useState(false);
  const [connectedAt, setConnectedAt] = useState<string | null>(null);

  const refreshStatus = useCallback(async () => {
    try {
      const status = await canvaApi.status();
      setConnected(status.connected);
      setConnectedAt(status.connected_at || null);
    } catch (e) {
      console.error('Failed to load Canva status:', e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refreshStatus(); }, [refreshStatus]);

  const handleConnect = useCallback(async () => {
    setConnecting(true);
    try {
      const { authorize_url } = await canvaApi.connect();
      const result = await WebBrowser.openAuthSessionAsync(authorize_url, 'memopad://canva-connected');
      if (result.type === 'success' && result.url) {
        const status = new URL(result.url).searchParams.get('status');
        if (status === 'success') {
          await refreshStatus();
          return;
        }
      }
      // type is 'cancel'/'dismiss' (user backed out) or the callback reported an error either
      // way - no alert on a plain cancel, since that's just the user changing their mind.
      if (result.type === 'success') {
        Alert.alert('Connection failed', 'Canva did not confirm the connection. Please try again.');
      }
    } catch (e) {
      console.error('Canva connect failed:', e);
      Alert.alert('Connection failed', 'Could not connect to Canva. Please try again.');
    } finally {
      setConnecting(false);
    }
  }, [refreshStatus]);

  const handleDisconnect = useCallback(() => {
    Alert.alert('Disconnect Canva?', 'You can reconnect at any time.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Disconnect',
        style: 'destructive',
        onPress: async () => {
          try {
            await canvaApi.disconnect();
            setConnected(false);
            setConnectedAt(null);
          } catch (e) {
            console.error('Canva disconnect failed:', e);
            Alert.alert('Error', 'Could not disconnect. Please try again.');
          }
        },
      },
    ]);
  }, []);

  if (loading) {
    return (
      <SafeAreaView style={s.container}>
        <View style={s.center}><ActivityIndicator size="large" color={C.primary} /></View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={s.container}>
      <View style={s.header}>
        <TouchableOpacity onPress={() => router.back()} style={s.backBtn}>
          <MaterialIcons name="arrow-back" size={28} color={C.textSec} />
        </TouchableOpacity>
        <Text style={s.headerTitle}>Canva</Text>
        <View style={{ width: 48 }} />
      </View>

      <ScrollView style={s.scroll} contentContainerStyle={s.scrollContent}>
        <View style={s.card}>
          <View style={s.row}>
            <MaterialIcons name={connected ? 'check-circle' : 'design-services'} size={24} color={connected ? C.success : C.textSec} />
            <View style={{ flex: 1, marginLeft: 16 }}>
              <Text style={s.rowLabelPlain}>{connected ? 'Connected' : 'Not connected'}</Text>
              <Text style={s.rowSub}>
                {connected
                  ? `Connected ${formatConnectedAt(connectedAt)}`
                  : 'Connect your Canva account to import designs straight into your notes.'}
              </Text>
            </View>
          </View>
        </View>

        <TouchableOpacity
          testID={connected ? 'canva-disconnect-btn' : 'canva-connect-btn'}
          style={[s.actionBtn, connected && s.disconnectBtn]}
          onPress={connected ? handleDisconnect : handleConnect}
          disabled={connecting}
        >
          {connecting
            ? <ActivityIndicator color={connected ? C.error : '#FFFFFF'} size="small" />
            : <Text style={[s.actionBtnText, connected && s.disconnectBtnText]}>
                {connected ? 'Disconnect' : 'Connect Canva'}
              </Text>}
        </TouchableOpacity>

        <View style={{ height: 40 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
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
  rowLabelPlain: { fontSize: 18, color: C.text, fontWeight: '600' },
  rowSub: { fontSize: 14, color: C.textSec, marginTop: 6, lineHeight: 20 },
  actionBtn: {
    marginTop: 20, height: 52, borderRadius: 12, backgroundColor: C.primary,
    alignItems: 'center', justifyContent: 'center',
  },
  actionBtnText: { fontSize: 16, fontWeight: '700', color: '#FFFFFF' },
  disconnectBtn: { backgroundColor: 'transparent', borderWidth: 2, borderColor: C.error },
  disconnectBtnText: { color: C.error },
});
