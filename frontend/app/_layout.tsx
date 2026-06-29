// MUST be first: installs a secure crypto.getRandomValues so @noble's randomBytes
// (used by the E2EE module) is a real CSPRNG on Hermes/React Native.
import 'react-native-get-random-values';
// Registers the native PBKDF2 KDF for the E2EE core (pure-JS is too slow on Hermes).
import '../src/crypto/kdf-native';
import React from 'react';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider, initialWindowMetrics } from 'react-native-safe-area-context';
import { AuthProvider, useAuth } from '../src/auth';
import { PostHogProvider } from '../src/analytics';
import { ErrorBoundary } from '../src/components';

// Inner component that has access to auth context for user ID
function AppWithAnalytics() {
  const { user } = useAuth();
  
  return (
    <PostHogProvider userId={user?.id}>
      <StatusBar style="dark" />
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Screen name="index" options={{ headerShown: false }} />
        <Stack.Screen name="welcome" options={{ headerShown: false, animation: 'fade' }} />
        <Stack.Screen name="login" options={{ headerShown: false, animation: 'slide_from_right' }} />
        <Stack.Screen name="signup" options={{ headerShown: false, animation: 'slide_from_right' }} />
        <Stack.Screen name="forgot-password" options={{ headerShown: false, animation: 'slide_from_right' }} />
        <Stack.Screen name="reset-password" options={{ headerShown: false, animation: 'slide_from_right' }} />
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="editor" options={{ animation: 'slide_from_right' }} />
        <Stack.Screen name="event-editor" options={{ presentation: 'modal' }} />
        <Stack.Screen name="change-password" options={{ animation: 'slide_from_right' }} />
        <Stack.Screen name="crypto-check" options={{ animation: 'slide_from_right' }} />
      </Stack>
    </PostHogProvider>
  );
}

export default function RootLayout() {
  return (
    <ErrorBoundary>
      <GestureHandlerRootView style={{ flex: 1 }}>
        <SafeAreaProvider initialMetrics={initialWindowMetrics}>
          <AuthProvider>
            <AppWithAnalytics />
          </AuthProvider>
        </SafeAreaProvider>
      </GestureHandlerRootView>
    </ErrorBoundary>
  );
}
