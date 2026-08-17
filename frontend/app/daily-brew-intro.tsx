/**
 * daily-brew-intro.tsx
 * First-login-only intro for the Daily Brew feature (gated on the daily-brew-enabled remote flag
 * - see (tabs)/_layout.tsx). Full-screen, modeled on analytics-consent.tsx: self-guards against
 * re-entry, gestureEnabled: false. Shows a static, non-interactive preview of DailyBrewCard
 * (`preview` prop - sample content, no live fetches, since the user hasn't granted location or
 * picked news sources yet) playing a one-time entrance animation, then "Next" sends the user on -
 * to the Daily Brew setup screen if it hasn't been answered yet, otherwise straight to the notes.
 */
import React, { useEffect } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useRouter, type Href } from 'expo-router';
import { C } from '../src/theme';
import { Button } from '../src/components';
import DailyBrewCard from '../src/components/DailyBrewCard';
import { useAuth } from '../src/auth';

const ONBOARDING_SEEN_KEY_PREFIX = 'daily_brew_onboarding_seen:';
// The earlier onboarding step that now shares a screen with the news-source picker - see
// handleNext for why this screen cares.
const LIFT_SEEN_KEY_PREFIX = 'daily_lift_onboarding_seen:';

export default function DailyBrewIntroScreen() {
  const router = useRouter();
  const { user } = useAuth();

  // If onboarding was already completed (or abandoned past this screen) for this account,
  // don't show it again - keyed by user id so switching accounts on one device doesn't
  // inherit another account's "already seen" state.
  useEffect(() => {
    if (!user) return;
    AsyncStorage.getItem(`${ONBOARDING_SEEN_KEY_PREFIX}${user.id}`)
      .then((v) => {
        if (v) {
          router.replace('/(tabs)');
          return;
        }
        // Marked the moment the intro is shown: the tabs gate re-runs on every focus, so a
        // flag written only on "Next" meant backing out of this screen looped straight back
        // into it.
        AsyncStorage.setItem(`${ONBOARDING_SEEN_KEY_PREFIX}${user.id}`, '1').catch(() => {});
      })
      .catch(() => {});
  }, [user]);

  const handleNext = async () => {
    // The source picker used to be a separate screen from the earlier "daily lift" onboarding
    // step; they're now one screen, so sending everyone there would ask the same three questions
    // a second time in the same run of onboarding. If that step has already been answered (which
    // it always has by the time this intro appears - see the gate order in (tabs)/_layout.tsx),
    // this is purely an explainer and the user goes straight to their notes.
    const liftSeen = user ? await AsyncStorage.getItem(`${LIFT_SEEN_KEY_PREFIX}${user.id}`).catch(() => null) : null;
    if (liftSeen) {
      router.replace('/(tabs)' as Href);
      return;
    }
    router.replace('/news-source-settings?onboarding=1' as Href);
  };

  return (
    <SafeAreaView style={s.container}>
      <View style={s.content}>
        <Text style={s.title}>Your Daily Brew</Text>
        <Text style={s.body}>
          A card at the top of My Notes with today&apos;s date, your events, and, once you set it
          up, news from home.
        </Text>

        {/* preview: static sample content + its own entrance animation (see DailyBrewCard.tsx) -
            non-interactive so taps here don't dismiss/navigate mid-onboarding. */}
        <View pointerEvents="none">
          <DailyBrewCard preview />
        </View>
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
  actions: { paddingHorizontal: 24, paddingBottom: 24 },
});
