// MUST be first: installs a secure crypto.getRandomValues so @noble's randomBytes
// (used by the E2EE module) is a real CSPRNG on Hermes/React Native.
import 'react-native-get-random-values';
// Registers the native PBKDF2 KDF for the E2EE core (pure-JS is too slow on Hermes).
import '../src/crypto/kdf-native';
// Defines the calendar-sync background task at module scope, so the OS can invoke it during a
// headless launch that never reaches the (tabs) layout.
import '../src/calendarSyncTask';
import React, { useEffect } from 'react';
import { Stack, useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider, initialWindowMetrics } from 'react-native-safe-area-context';
import { ShareIntentProvider } from 'expo-share-intent';
import { AuthProvider, useAuth } from '../src/auth';
import { PostHogProvider } from '../src/analytics';
import { ErrorBoundary, ShareIntentHandler } from '../src/components';
import { setupNotificationHandler, setupNotificationTapHandler } from '../src/notifications';

// Inner component that has access to auth context for user ID
function AppWithAnalytics() {
  const { user } = useAuth();
  const router = useRouter();

  // Foreground reminder presentation + tap → open the linked event.
  useEffect(() => {
    setupNotificationHandler();
    const unsubscribe = setupNotificationTapHandler((eventId) => {
      router.push({ pathname: '/event-editor', params: { eventId } });
    });
    return unsubscribe;
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
        <Stack.Screen name="editor" options={{ animation: 'slide_from_right' }} />
        <Stack.Screen name="share-target" options={{ presentation: 'modal' }} />
        <Stack.Screen name="event-editor" options={{ presentation: 'modal' }} />
        <Stack.Screen name="change-password" options={{ animation: 'slide_from_right' }} />
        <Stack.Screen name="calendar-sync-settings" options={{ animation: 'slide_from_right' }} />
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
      <ShareIntentProvider options={{ debug: false, resetOnBackground: true, scheme: 'memopad' }}>
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
