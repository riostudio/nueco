import React from 'react';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { AuthProvider, useAuth } from '../src/auth';
import { PostHogProvider } from '../src/analytics';

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
      </Stack>
    </PostHogProvider>
  );
}

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <AuthProvider>
        <AppWithAnalytics />
      </AuthProvider>
    </GestureHandlerRootView>
  );
}
