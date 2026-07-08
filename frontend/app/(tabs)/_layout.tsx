import { Tabs } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { StyleSheet, View, Alert } from 'react-native';
import React from 'react';
import { UserAvatar, useAuth } from '../../src/auth';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { useRouter } from 'expo-router';
import { WebView } from 'react-native-webview';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AnalyticsConsent } from '../../src/components';

const C = {
  primary: '#D84315',
  inactiveTab: '#757575',
  surface: '#FFFFFF',
  border: '#121212',
  bg: '#FDFBF7',
  text: '#121212',
};

function NotesIcon({ color }: { color: string }) {
  return <MaterialIcons name="description" size={22} color={color} />;
}

function CalendarIcon({ color }: { color: string }) {
  return <MaterialIcons name="calendar-today" size={22} color={color} />;
}

function EventsIcon({ color }: { color: string }) {
  return <MaterialIcons name="event-note" size={22} color={color} />;
}

function HeaderRight() {
  return (
    <View style={styles.headerRight}>
      <UserAvatar size={36} />
    </View>
  );
}

export default function TabLayout() {
  const { logout } = useAuth();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const handleLogout = () => {
    Alert.alert(
      'Log Out',
      'Are you sure you want to log out?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Log Out',
          style: 'destructive',
          onPress: async () => {
            await logout();
            router.replace('/welcome');
          },
        },
      ]
    );
  };

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <Tabs
        screenOptions={{
          headerShown: false,
          // Lift the tab bar above the Android system navigation bar. An explicit height disables
          // react-navigation's automatic safe-area handling, so add the bottom inset ourselves.
          tabBarStyle: [styles.tabBar, { height: 80 + insets.bottom, paddingBottom: 16 + insets.bottom }],
          tabBarActiveTintColor: C.primary,
          tabBarInactiveTintColor: C.inactiveTab,
          tabBarLabelStyle: styles.tabLabel,
        }}
      >
        <Tabs.Screen
          name="index"
          options={{
            title: 'My Notes',
            tabBarIcon: NotesIcon,
          }}
        />
        <Tabs.Screen
          name="calendar"
          options={{
            title: 'Calendar',
            tabBarIcon: CalendarIcon,
          }}
        />
        <Tabs.Screen
          name="events"
          options={{
            title: 'Events',
            tabBarIcon: EventsIcon,
          }}
        />
        <Tabs.Screen
          name="settings"
          options={{
            href: null, // Hide settings tab from navigation
          }}
        />
      </Tabs>
      {/* Off-screen 1px WebView that pre-warms the Android System WebView engine while the user is in
          the tabs, so the first note editor (TenTap = a WebView) opens fast instead of paying the
          engine cold-start on demand. */}
      <View style={styles.prewarm} pointerEvents="none">
        <WebView source={{ html: '<html></html>' }} style={{ flex: 1, opacity: 0 }} />
      </View>
      {/* One-time opt-in consent for usage analytics (GDPR). */}
      <AnalyticsConsent />
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  prewarm: { position: 'absolute', width: 1, height: 1, left: -100, top: -100, opacity: 0 },
  header: {
    backgroundColor: C.bg,
    borderBottomWidth: 1,
    borderBottomColor: '#E0E0E0',
  },
  headerTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: C.text,
  },
  headerRight: {
    marginRight: 16,
  },
  tabBar: {
    height: 80,
    paddingTop: 6,
    paddingBottom: 16,
    backgroundColor: C.surface,
    borderTopWidth: 1,
    borderTopColor: '#E0E0E0',
  },
  tabLabel: {
    fontSize: 12,
    fontWeight: '600',
    marginTop: 2,
  },
});
