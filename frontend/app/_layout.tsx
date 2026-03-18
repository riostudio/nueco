import React, { useEffect, useState } from 'react';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { useRegisterDevice, authStorage, User } from '../src/auth';

export default function RootLayout() {
  const { registerDevice } = useRegisterDevice();
  const [user, setUser] = useState<User | null>(null);

  useEffect(() => {
    // Silent device registration on app launch
    const initAuth = async () => {
      try {
        // Check if user already exists in storage
        const storedUser = await authStorage.getUser();
        if (storedUser) {
          setUser(JSON.parse(storedUser));
        }
        // Register device in background (don't await, don't block UI)
        registerDevice().then((result) => {
          if (result.success) {
            setUser(result.data);
          }
        });
      } catch (error) {
        console.error('Auth init error:', error);
      }
    };
    initAuth();
  }, [registerDevice]);

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <StatusBar style="dark" />
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="index" options={{ headerShown: false }} />
        <Stack.Screen name="editor" options={{ animation: 'slide_from_right' }} />
        <Stack.Screen name="event-editor" options={{ presentation: 'modal' }} />
        <Stack.Screen name="change-password" options={{ animation: 'slide_from_right' }} />
      </Stack>
    </GestureHandlerRootView>
  );
}
