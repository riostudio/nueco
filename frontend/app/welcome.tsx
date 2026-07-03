import React from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  SafeAreaView,
  Image,
  StatusBar,
} from 'react-native';
import { useRouter, type Href } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { DIAGNOSTICS_ENABLED } from '../src/crypto/flags';

export default function WelcomeScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar barStyle="dark-content" backgroundColor="#FDFBF7" />
      <View style={styles.container}>
        {/* Logo and Branding */}
        <View style={styles.brandSection}>
          <View style={styles.logoContainer}>
            <Ionicons name="document-text" size={64} color="#D84315" />
          </View>
          <Text style={styles.appName}>MemoPad</Text>
          <Text style={styles.tagline}>Your thoughts, organized simply</Text>
        </View>

        {/* Features Highlight */}
        <View style={styles.featuresSection}>
          <View style={styles.featureItem}>
            <Ionicons name="mic" size={28} color="#1565C0" />
            <Text style={styles.featureText}>Voice-to-text notes</Text>
          </View>
          <View style={styles.featureItem}>
            <Ionicons name="sync" size={28} color="#1565C0" />
            <Text style={styles.featureText}>Sync across devices</Text>
          </View>
          <View style={styles.featureItem}>
            <Ionicons name="calendar" size={28} color="#1565C0" />
            <Text style={styles.featureText}>Calendar integration</Text>
          </View>
        </View>

        {/* Action Buttons */}
        <View style={[styles.buttonSection, { paddingBottom: insets.bottom + 24 }]}>
          <TouchableOpacity
            style={styles.primaryButton}
            onPress={() => router.push('/signup')}
            activeOpacity={0.8}
          >
            <Text style={styles.primaryButtonText}>Get Started</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.secondaryButton}
            onPress={() => router.push('/login')}
            activeOpacity={0.8}
          >
            <Text style={styles.secondaryButtonText}>Login</Text>
          </TouchableOpacity>

          {/* Diagnostic: on-device E2EE self-check & PBKDF2 benchmark.
              Dev/preview only — hidden in production so end users never see it. */}
          {DIAGNOSTICS_ENABLED && (
            <TouchableOpacity
              onPress={() => router.push('/crypto-check' as Href)}
              activeOpacity={0.6}
              style={styles.diagLink}
              hitSlop={{ top: 12, bottom: 12, left: 24, right: 24 }}
            >
              <Text style={styles.diagLinkText}>🔒 Crypto self-check</Text>
            </TouchableOpacity>
          )}
        </View>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: '#FDFBF7',
  },
  container: {
    flex: 1,
    paddingHorizontal: 24,
  },
  brandSection: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingTop: 40,
  },
  logoContainer: {
    width: 120,
    height: 120,
    borderRadius: 30,
    backgroundColor: '#FFF3E0',
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 24,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.1,
    shadowRadius: 12,
    elevation: 4,
  },
  appName: {
    fontSize: 42,
    fontWeight: '700',
    color: '#121212',
    marginBottom: 8,
  },
  tagline: {
    fontSize: 20,
    color: '#546E7A',
    textAlign: 'center',
  },
  featuresSection: {
    paddingVertical: 32,
    gap: 20,
    marginHorizontal: 0,
  },
  featureItem: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    padding: 16,
    borderRadius: 16,
    gap: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 8,
    elevation: 2,
  },
  featureText: {
    fontSize: 18,
    color: '#37474F',
    fontWeight: '500',
  },
  buttonSection: {
    // paddingBottom is applied dynamically from safe-area insets so the
    // diagnostic link never lands inside the Android gesture-nav zone.
    gap: 16,
    marginHorizontal: 0,
  },
  primaryButton: {
    backgroundColor: '#D84315',
    paddingVertical: 18,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 60,
    shadowColor: '#D84315',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 4,
  },
  primaryButtonText: {
    color: '#FFFFFF',
    fontSize: 20,
    fontWeight: '700',
  },
  secondaryButton: {
    backgroundColor: 'transparent',
    paddingVertical: 18,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 60,
    borderWidth: 2,
    borderColor: '#D84315',
  },
  secondaryButtonText: {
    color: '#D84315',
    fontSize: 18,
    fontWeight: '600',
  },
  diagLink: {
    alignItems: 'center',
    paddingVertical: 12,
    marginTop: 4,
  },
  diagLinkText: {
    color: '#90A4AE',
    fontSize: 14,
    fontWeight: '500',
  },
});
