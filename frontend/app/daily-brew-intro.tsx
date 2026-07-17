/**
 * daily-brew-intro.tsx
 * First-login-only intro for the Daily Brew feature (gated on the daily-brew-enabled remote flag
 * - see (tabs)/_layout.tsx). Full-screen, modeled on analytics-consent.tsx: self-guards against
 * re-entry, gestureEnabled: false. Shows a live, non-interactive preview of DailyBrewCard (same
 * automatic event/weather/news fetch as the real card - see DailyBrewCard.tsx and
 * dailyBrew.ts's fetchWeather for the GPS-fetch timeout that keeps this from stalling) playing
 * a one-time entrance animation, then "Next" sends the user to the news-source picker.
 */
import React, { useEffect, useRef } from 'react';
import { View, Text, StyleSheet, Animated } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useRouter, type Href } from 'expo-router';
import { C } from '../src/theme';
import { Button } from '../src/components';
import DailyBrewCard from '../src/components/DailyBrewCard';

const ONBOARDING_SEEN_KEY = 'daily_brew_onboarding_seen';

export default function DailyBrewIntroScreen() {
  const router = useRouter();
  const translateY = useRef(new Animated.Value(24)).current;
  const opacity = useRef(new Animated.Value(0)).current;

  // If onboarding was already completed (or abandoned past this screen), don't show it again.
  useEffect(() => {
    AsyncStorage.getItem(ONBOARDING_SEEN_KEY).then((v) => { if (v) router.replace('/(tabs)'); }).catch(() => {});
  }, []);

  // One-time entrance for the card preview - same spring+fade shape as FeedbackToast.tsx.
  useEffect(() => {
    Animated.parallel([
      Animated.spring(translateY, { toValue: 0, useNativeDriver: true, friction: 8 }),
      Animated.timing(opacity, { toValue: 1, duration: 220, useNativeDriver: true }),
    ]).start();
  }, []);

  const handleNext = async () => {
    // Marked on leaving (not on mount) so the intro is never shown twice even if the user
    // abandons the source-picker step that follows.
    await AsyncStorage.setItem(ONBOARDING_SEEN_KEY, '1').catch(() => {});
    router.replace('/news-source-settings?onboarding=1' as Href);
  };

  return (
    <SafeAreaView style={s.container}>
      <View style={s.content}>
        <Text style={s.title}>Your Daily Brew</Text>
        <Text style={s.body}>
          A card at the top of My Notes with today&apos;s date, your next event, and, once you set
          it up, news from home.
        </Text>

        {/* Live preview - non-interactive so taps here don't dismiss/navigate mid-onboarding. */}
        <Animated.View style={[s.preview, { opacity, transform: [{ translateY }] }]} pointerEvents="none">
          <DailyBrewCard />
        </Animated.View>
      </View>

      <View style={s.actions}>
        <Button testID="daily-brew-intro-next" variant="cta" label="Next" onPress={handleNext} />
      </View>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg, justifyContent: 'space-between' },
  content: { flex: 1, paddingHorizontal: 28, paddingTop: 40 },
  title: { fontSize: 28, fontWeight: '700', color: C.text, textAlign: 'center', marginBottom: 16 },
  body: { fontSize: 17, color: C.textSec, textAlign: 'center', lineHeight: 24, marginBottom: 28 },
  preview: {},
  actions: { paddingHorizontal: 24, paddingBottom: 24 },
});
