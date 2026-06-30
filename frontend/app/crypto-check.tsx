/**
 * On-device E2EE self-check & PBKDF2 benchmark.
 *
 * Diagnostic route (/crypto-check) used to validate the crypto core on a real
 * device: Hermes CSPRNG (via react-native-get-random-values), AES-256-GCM
 * round-trip/tamper, escrow unlock, password-reset preservation, SecureStore
 * persistence, and native PBKDF2 cost at several iteration counts. Not part of
 * normal app flow.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Platform, Pressable, ScrollView, Text, View } from 'react-native';
import * as SecureStore from 'expo-secure-store';
// Ensure the native KDF is registered even if this screen is reached first.
import '../src/crypto/kdf-native';
import * as e2ee from '../src/crypto/e2ee';

type Status = 'pass' | 'fail' | 'info';
interface Row {
  name: string;
  status: Status;
  detail?: string;
}

const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);

export default function CryptoCheck() {
  const [rows, setRows] = useState<Row[]>([]);
  const [running, setRunning] = useState(false);

  const run = useCallback(async () => {
    setRunning(true);
    const out: Row[] = [];
    const ok = (name: string, cond: boolean, detail?: string) =>
      out.push({ name, status: cond ? 'pass' : 'fail', detail });
    const info = (name: string, detail: string) => out.push({ name, status: 'info', detail });
    const expectThrow = (name: string, fn: () => unknown) => {
      try {
        fn();
        out.push({ name, status: 'fail', detail: 'expected throw' });
      } catch {
        out.push({ name, status: 'pass' });
      }
    };

    try {
      info('device', `${Platform.OS} ${Platform.Version}`);

      // --- CSPRNG (polyfill must be active) ---
      const r1 = e2ee.generateDek();
      const r2 = e2ee.generateDek();
      ok('CSPRNG: 32-byte key', r1.length === 32);
      ok('CSPRNG: keys differ (polyfill active)', !sameBytes(r1, r2));
      ok('CSPRNG: not all-zero', r1.some((x) => x !== 0));

      // --- AES-256-GCM ---
      const key = e2ee.generateDek();
      const msg = 'on-device ✓ café 北京 😀🎉';
      const tok = e2ee.encryptString(msg, key);
      ok('AES-GCM round-trip', e2ee.decryptString(tok, key) === msg);
      ok('ciphertext ≠ plaintext', !tok.includes('café'));
      expectThrow('wrong key rejected', () => e2ee.decryptString(tok, e2ee.generateDek()));
      const p = tok.split('.');
      const tampered = `${p[0]}.${p[1]}.${p[2][0] === 'A' ? 'B' : 'A'}${p[2].slice(1)}`;
      expectThrow('tamper rejected', () => e2ee.decryptString(tampered, key));

      // --- escrow lifecycle + login/signup cost ---
      let t = Date.now();
      const esc = e2ee.createEscrow('hunter2-password');
      info('createEscrow (2× pbkdf2, signup)', `${Date.now() - t} ms`);
      t = Date.now();
      const dek = e2ee.unlockWithPassword(esc.bundle, 'hunter2-password');
      info('unlockWithPassword (login)', `${Date.now() - t} ms`);
      ok('escrow → same DEK (password)', sameBytes(dek, esc.dek));
      ok('escrow → same DEK (recovery)', sameBytes(e2ee.unlockWithRecovery(esc.bundle, esc.recoveryCode), esc.dek));
      expectThrow('wrong password rejected', () => e2ee.unlockWithPassword(esc.bundle, 'nope'));

      // --- password reset preserves notes ---
      const note = e2ee.encryptString('pre-reset note', esc.dek);
      const nb = e2ee.rewrapForNewPassword(esc.bundle, esc.recoveryCode, 'new-password');
      ok('note readable after reset', e2ee.decryptString(note, e2ee.unlockWithPassword(nb, 'new-password')) === 'pre-reset note');

      // --- PBKDF2 cost curve on this device (native, sha512) ---
      for (const iterations of [100_000, 210_000, 600_000]) {
        const salt = e2ee.generateDek().slice(0, 16);
        const ts = Date.now();
        e2ee.deriveKek('benchmark', salt, { iterations, hash: 'sha512', dkLen: 32 });
        info(`pbkdf2 sha512 ×${iterations.toLocaleString()}`, `${Date.now() - ts} ms`);
      }

      // --- SecureStore persistence ---
      try {
        const k = 'e2ee_selfcheck';
        await SecureStore.setItemAsync(k, esc.bundle.wrapped_by_password);
        const got = await SecureStore.getItemAsync(k);
        ok('SecureStore round-trip', got === esc.bundle.wrapped_by_password);
        await SecureStore.deleteItemAsync(k);
        ok('SecureStore delete', (await SecureStore.getItemAsync(k)) === null);
      } catch (e: any) {
        ok('SecureStore', false, String(e?.message ?? e));
      }
    } catch (e: any) {
      out.push({ name: 'FATAL', status: 'fail', detail: String(e?.stack ?? e?.message ?? e) });
    }

    setRows(out);
    setRunning(false);
  }, []);

  useEffect(() => {
    run();
  }, [run]);

  const fails = rows.filter((r) => r.status === 'fail').length;
  const passes = rows.filter((r) => r.status === 'pass').length;
  const color = (s: Status) => (s === 'pass' ? '#2E7D32' : s === 'fail' ? '#C62828' : '#546E7A');

  return (
    <ScrollView style={{ flex: 1, backgroundColor: '#FDFBF7' }} contentContainerStyle={{ padding: 20, paddingTop: 60 }}>
      <Text style={{ fontSize: 24, fontWeight: '700', color: '#121212', marginBottom: 4 }}>E2EE self-check</Text>
      <Text style={{ fontSize: 16, color: fails ? '#C62828' : '#2E7D32', marginBottom: 16 }}>
        {running ? 'running…' : `${passes} passed · ${fails} failed`}
      </Text>
      {running && <ActivityIndicator />}
      {rows.map((r, i) => (
        <View key={i} style={{ flexDirection: 'row', paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: '#EFE9DD' }}>
          <Text style={{ width: 22, color: color(r.status) }}>{r.status === 'pass' ? '✓' : r.status === 'fail' ? '✗' : '•'}</Text>
          <View style={{ flex: 1 }}>
            <Text style={{ color: '#121212', fontSize: 15 }}>{r.name}</Text>
            {!!r.detail && <Text style={{ color: color(r.status), fontSize: 13 }}>{r.detail}</Text>}
          </View>
        </View>
      ))}
      <Pressable
        onPress={run}
        disabled={running}
        style={{ marginTop: 24, padding: 16, backgroundColor: '#D84315', borderRadius: 12, alignItems: 'center', opacity: running ? 0.5 : 1 }}
      >
        <Text style={{ color: '#fff', fontWeight: '600', fontSize: 16 }}>Re-run</Text>
      </Pressable>
    </ScrollView>
  );
}
