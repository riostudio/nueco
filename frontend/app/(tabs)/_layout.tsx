import { Tabs, type Href } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { StyleSheet, View, Alert, Platform } from 'react-native';
import React, { useEffect } from 'react';
import { UserAvatar, useAuth } from '../../src/auth';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { hasAnalyticsDecision } from '../../src/analytics';
import { registerForPushNotifications, unregisterPushNotifications, refreshRecurringReminders } from '../../src/notifications';
import { runCalendarSync } from '../../src/calendarSync';
import { isGoogleConnectAvailable, isGoogleConnected } from '../../src/google/auth';
import { registerCalendarSyncTaskAsync } from '../../src/calendarSyncTask';
import { refreshRecurringDeviceCalendarEntries } from '../../src/deviceCalendarSync';
import { C } from '../../src/theme';

// The WebView pre-warm below is specifically an Android System WebView cold-start workaround -
// iOS's WKWebView doesn't need it, and react-native-webview doesn't officially support web at
// all, so importing/rendering it unconditionally risked breaking (or at best wastefully
// rendering on) every other platform. Same require-gate pattern as expo-calendar/expo-location
// elsewhere in this app.
let WebView: typeof import('react-native-webview').WebView | null = null;
if (Platform.OS === 'android') {
  try { WebView = require('react-native-webview').WebView; } catch {}
}

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
  const { logout, user } = useAuth();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  // Register this device for reminder push notifications once we're in the app (authenticated).
  useEffect(() => { registerForPushNotifications(); }, []);

  // First-run gates, in order: analytics consent (legal), Google Calendar connect (one-time
  // permission ask), voice capture (the core "first note" moment). Anything that is a preference
  // with a safe default (daily lift, reminder voice) is deliberately NOT here - those live in
  // settings, where the user can find them once they've experienced the feature they configure.
  useEffect(() => {
    if (!user) return;
    hasAnalyticsDecision().then(async (decided) => {
      if (!decided) {
        router.replace('/analytics-consent' as Href);
        return;
      }
      // Placed BEFORE the account-age skip on purpose - existing accounts updating into this
      // build get asked once too.
      if (isGoogleConnectAvailable()) {
        const googleSeen = await AsyncStorage.getItem(`google_connect_onboarding_seen:${user.id}`);
        if (!googleSeen && !(await isGoogleConnected().catch(() => false))) {
          router.replace('/google-connect-intro' as Href);
          return;
        }
      }
      // Voice onboarding is for genuinely NEW accounts, and the signal for that is the ACCOUNT'S
      // AGE, not local storage: clearLocalData() only runs on account deletion, never on logout,
      // so a device can hold a previous account's notes while the logged-in account is brand new.
      // created_at belongs to the account itself, so switching accounts or reinstalling can't
      // confuse it. A week is generous for someone who registers and doesn't open the app for a
      // few days; an unparseable created_at falls through to showing onboarding.
      const voiceKey = `voice_onboarding_seen:${user.id}`;
      if (!(await AsyncStorage.getItem(voiceKey))) {
        const createdAt = user.created_at ? new Date(user.created_at).getTime() : NaN;
        const accountAgeMs = Number.isFinite(createdAt) ? Date.now() - createdAt : 0;
        if (accountAgeMs > 7 * 24 * 60 * 60 * 1000) {
          await AsyncStorage.setItem(voiceKey, '1').catch(() => {});
          return;
        }
        router.replace('/voice-onboarding' as Href);
      }
    }).catch(() => {});
  }, [user]);

  // Calendar sync: the reliable trigger is "whenever the app is opened" (throttled inside
  // runCalendarSync itself); the background task registered here is a best-effort bonus on top -
  // see src/calendarSyncTask.ts for why it can't be relied on alone.
  useEffect(() => {
    runCalendarSync().catch(() => {});
    registerCalendarSyncTaskAsync().catch(() => {});
    // Rolls each recurring event's device-calendar entry forward to its current next
    // occurrence - the periodic-refresh half of the reliability-backup device calendar
    // write (event-editor.tsx's writeToDeviceCalendar handles the create/edit-time half).
    refreshRecurringDeviceCalendarEntries().catch(() => {});
    // Same idea for local reminder notifications - a recurring event's reminder otherwise
    // only ever fires for its very first occurrence (event-editor.tsx's scheduleReminder
    // handles the create/edit-time half; expo-notifications' DATE trigger is one-shot).
    refreshRecurringReminders().catch(() => {});
  }, []);

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
            await unregisterPushNotifications();
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
          // Calendar and Events don't mount until first visited. Previously all three tab screens
          // mounted during the very first render of the app, so opening to Notes also paid for
          // building a month grid and an events list nobody had asked to see yet.
          lazy: true,
          // Stop rendering a tab once it's off screen. All three stay mounted after first visit
          // (that's what keeps switching instant), but without this they keep re-rendering in the
          // background on every state change in a shared store - work whose result nobody sees.
          freezeOnBlur: true,
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
      </Tabs>
      {/* Off-screen 1px WebView that pre-warms the Android System WebView engine while the user is in
          the tabs, so the first note editor (TenTap = a WebView) opens fast instead of paying the
          engine cold-start on demand. Android-only, see the WebView require-gate above. */}
      {WebView && (
        <View style={styles.prewarm} pointerEvents="none">
          <WebView source={{ html: '<html></html>' }} style={{ flex: 1, opacity: 0 }} />
        </View>
      )}
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
