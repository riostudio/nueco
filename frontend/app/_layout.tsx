// MUST be first: installs a secure crypto.getRandomValues so @noble's randomBytes
// (used by the E2EE module) is a real CSPRNG on Hermes/React Native.
import 'react-native-get-random-values';
// Registers the native PBKDF2 KDF for the E2EE core (pure-JS is too slow on Hermes).
import '../src/crypto/kdf-native';
// Defines the calendar-sync background task at module scope, so the OS can invoke it during a
// headless launch that never reaches the (tabs) layout.
import '../src/calendarSyncTask';
import * as WebBrowser from 'expo-web-browser';
import React, { useEffect } from 'react';
import { Alert } from 'react-native';
import { Stack, useRouter, type Href } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider, initialWindowMetrics } from 'react-native-safe-area-context';
import { ShareIntentProvider } from 'expo-share-intent';
import { AuthProvider, useAuth } from '../src/auth';
import { PostHogProvider } from '../src/analytics';
import { ErrorBoundary, ShareIntentHandler } from '../src/components';
import { setupNotificationHandler, setupNotificationTapHandler } from '../src/notifications';
import { sweepExpiredRecordings } from '../src/audio/recordingStore';
import {
  repairStaleRecordingLinks,
  setClassifyImprovementListener,
  removeOfflineClassifyItem,
  updateEventOffline,
} from '../src/offlineSync';
import { setPendingVoiceExtraction } from '../src/pendingVoiceEvents';

// Completes the browser round-trip for expo-auth-session (Google Calendar connect). No-op when
// there is no pending auth redirect.
WebBrowser.maybeCompleteAuthSession();

// Inner component that has access to auth context for user ID
function AppWithAnalytics() {
  const { user } = useAuth();
  const router = useRouter();

  // Foreground reminder presentation + tap → open the linked event.
  useEffect(() => {
    setupNotificationHandler();
    const unsubscribe = setupNotificationTapHandler((eventId) => {
      router.push(`/event?eventId=${eventId}` as Href);
    });
    return unsubscribe;
  }, [router]);

  // Retention sweep on every app start (plan.md M5): expired voice recordings are removed
  // per the user's preference. Fire-and-forget; never blocks startup.
  useEffect(() => {
    sweepExpiredRecordings().catch(() => {});
    // Re-point recordings stranded on pre-sync temp note ids (aliased at sync time; the
    // persisted alias map makes this safe to replay on every start).
    repairStaleRecordingLinks().catch(() => {});
  }, []);

  // When reconnect lets the cloud classifier revisit an offline capture and it disagrees with
  // the local rule engine, offer the user the upgrade - never apply silently.
  useEffect(() => {
    setClassifyImprovementListener((improvements) => {
      const { item, cloud } = improvements[0];
      const first = cloud.events[0];
      const summary = first
        ? `${first.title}${first.start_time ? ` — ${new Date(first.start_time).toLocaleString()}` : ''}`
        : 'A clearer reading of what you said.';
      Alert.alert(
        'Better schedule found',
        `Now that you're back online, we read your voice note again and got:\n\n${summary}`,
        [
          {
            text: 'Dismiss',
            style: 'cancel',
            onPress: () => removeOfflineClassifyItem(item.id).catch(() => {}),
          },
          {
            text: 'Review',
            onPress: async () => {
              const created = item.createdEventIds ?? [];
              if (created.length > 0 && created.length === cloud.events.length) {
                // Same event count - patch the existing events in place.
                for (let i = 0; i < created.length; i++) {
                  const ev = cloud.events[i];
                  await updateEventOffline(created[i], {
                    title: ev.title,
                    start_time: ev.start_time,
                    end_time: ev.end_time ?? undefined,
                    location: ev.location,
                    recurrence: ev.recurrence,
                  }).catch(() => {});
                }
                await removeOfflineClassifyItem(item.id).catch(() => {});
              } else {
                // Counts differ (or nothing was created yet) - stage the cloud result and let
                // the user confirm it through the normal voice-event flow.
                setPendingVoiceExtraction({
                  ...cloud,
                  transcript: item.transcript,
                  noteId: '',
                  localClassifyQueueId: item.id,
                });
                router.push('/voice-event' as Href);
              }
            },
          },
        ],
      );
    });
    return () => setClassifyImprovementListener(null);
  }, [router]);

  return (
    <PostHogProvider userId={user?.id}>
      <StatusBar style="dark" />
      {/* Routes OS shares into the editor; renders nothing. Needs auth + router context. */}
      <ShareIntentHandler />
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Screen name="index" options={{ headerShown: false }} />
        <Stack.Screen name="welcome" options={{ headerShown: false, animation: 'fade' }} />
        <Stack.Screen name="login" options={{ headerShown: false, animation: 'slide_from_right' }} />
        <Stack.Screen name="signup" options={{ headerShown: false, animation: 'slide_from_right' }} />
        <Stack.Screen name="forgot-password" options={{ headerShown: false, animation: 'slide_from_right' }} />
        <Stack.Screen name="reset-password" options={{ headerShown: false, animation: 'slide_from_right' }} />
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="analytics-consent" options={{ headerShown: false, gestureEnabled: false, animation: 'fade' }} />
        <Stack.Screen name="google-connect-intro" options={{ headerShown: false, gestureEnabled: false, animation: 'fade' }} />
        <Stack.Screen name="daily-brew-intro" options={{ headerShown: false, gestureEnabled: false, animation: 'fade' }} />
        <Stack.Screen name="editor" options={{ animation: 'slide_from_right' }} />
        <Stack.Screen name="share-target" options={{ presentation: 'modal' }} />
        <Stack.Screen name="event-editor" options={{ presentation: 'modal' }} />
        <Stack.Screen name="trips" options={{ animation: 'slide_from_right' }} />
        <Stack.Screen name="trip-editor" options={{ presentation: 'modal' }} />
        <Stack.Screen name="sketch" options={{ presentation: 'modal' }} />
        <Stack.Screen name="daily-verse" options={{ presentation: 'modal' }} />
        <Stack.Screen name="settings" options={{ animation: 'slide_from_right' }} />
        <Stack.Screen name="change-password" options={{ animation: 'slide_from_right' }} />
        <Stack.Screen name="calendar-sync-settings" options={{ animation: 'slide_from_right' }} />
        <Stack.Screen name="google-calendar-settings" options={{ animation: 'slide_from_right' }} />
        <Stack.Screen name="news-source-settings" options={{ animation: 'slide_from_right' }} />
        <Stack.Screen name="canva-settings" options={{ animation: 'slide_from_right' }} />
        <Stack.Screen name="recovery-code" options={{ headerShown: false, gestureEnabled: false }} />
        <Stack.Screen name="recover-key" options={{ headerShown: false, gestureEnabled: false }} />
        <Stack.Screen name="crypto-check" options={{ animation: 'slide_from_right' }} />
      </Stack>
    </PostHogProvider>
  );
}

export default function RootLayout() {
  return (
    <ErrorBoundary>
      <ShareIntentProvider options={{ debug: false, resetOnBackground: true, scheme: 'nueco' }}>
        <GestureHandlerRootView style={{ flex: 1 }}>
          <SafeAreaProvider initialMetrics={initialWindowMetrics}>
            <AuthProvider>
              <AppWithAnalytics />
            </AuthProvider>
          </SafeAreaProvider>
        </GestureHandlerRootView>
      </ShareIntentProvider>
    </ErrorBoundary>
  );
}
