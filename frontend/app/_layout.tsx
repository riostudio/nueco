import React from 'react';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { AuthProvider } from '../src/auth';

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <AuthProvider>
        <StatusBar style="dark" />
        <Stack screenOptions={{ headerShown: false }}>
          <Stack.Screen name="(tabs)" />
          <Stack.Screen name="index" options={{ headerShown: false }} />
          <Stack.Screen name="editor" options={{ animation: 'slide_from_right' }} />
          <Stack.Screen name="event-editor" options={{ presentation: 'modal' }} />
          <Stack.Screen name="change-password" options={{ animation: 'slide_from_right' }} />
        </Stack>
      </AuthProvider>
    </GestureHandlerRootView>
  );
}
