import React from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Image,
  StatusBar,
} from 'react-native';
import { useRouter, type Href } from 'expo-router';
// react-native's own SafeAreaView already applies the iOS home-indicator inset automatically -
// this screen also manually adds `insets.bottom + 24` to buttonSection below (intended for
// Android's gesture-nav zone), so using react-native's version double-counted the bottom inset
// on iPhone X+. Matches the SafeAreaView source every other screen in the app already uses.
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { MaterialIcons } from '@expo/vector-icons';
import { DIAGNOSTICS_ENABLED } from '../src/crypto/flags';
import { C, radius, borderWidth } from '../src/theme';
import { Button } from '../src/components';

export default function WelcomeScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();

  return (
    <SafeAreaView style={styles.safeArea} edges={['top']}>
      <StatusBar barStyle="dark-content" backgroundColor={C.bg} />
      <View style={styles.container}>
        {/* Logo and Branding */}
        <View style={styles.brandSection}>
          <View style={styles.logoContainer}>
            <Image source={require('../assets/images/icon.png')} style={styles.logoImage} />
          </View>
          <Text style={styles.appName}>Nueco</Text>
          <Text style={styles.tagline}>Your thoughts, organized simply</Text>
        </View>

        {/* Features Highlight */}
        <View style={styles.featuresSection}>
          <View style={styles.featureItem}>
            <MaterialIcons name="mic" size={28} color={C.secondary} />
            <Text style={styles.featureText}>Voice-to-text notes</Text>
          </View>
          <View style={styles.featureItem}>
            <MaterialIcons name="sync" size={28} color={C.secondary} />
            <Text style={styles.featureText}>Sync across devices</Text>
          </View>
          <View style={styles.featureItem}>
            <MaterialIcons name="event" size={28} color={C.secondary} />
            <Text style={styles.featureText}>Calendar integration</Text>
          </View>
        </View>

        {/* Action Buttons */}
        <View style={[styles.buttonSection, { paddingBottom: insets.bottom + 24 }]}>
          <Button variant="cta" label="Get Started" onPress={() => router.push('/signup')} />
          <Button variant="outline" label="Login" onPress={() => router.push('/login')} />

          {/* Diagnostic: on-device E2EE self-check & PBKDF2 benchmark.
              Dev/preview only - hidden in production so end users never see it. */}
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
    backgroundColor: C.bg,
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
    borderRadius: 28,
    overflow: 'hidden',
    marginBottom: 24,
  },
  logoImage: {
    width: 120,
    height: 120,
  },
  appName: {
    fontSize: 42,
    fontWeight: '700',
    color: C.text,
    marginBottom: 8,
  },
  tagline: {
    fontSize: 20,
    color: C.icon,
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
    backgroundColor: C.surface,
    padding: 16,
    borderRadius: radius.lg,
    borderWidth: borderWidth.regular,
    borderColor: C.borderSub,
    gap: 16,
  },
  featureText: {
    fontSize: 18,
    color: C.textSec,
    fontWeight: '500',
  },
  buttonSection: {
    // paddingBottom is applied dynamically from safe-area insets so the
    // diagnostic link never lands inside the Android gesture-nav zone.
    gap: 16,
    marginHorizontal: 0,
  },
  diagLink: {
    alignItems: 'center',
    paddingVertical: 12,
    marginTop: 4,
  },
  diagLinkText: {
    color: C.placeholder,
    fontSize: 14,
    fontWeight: '500',
  },
});
