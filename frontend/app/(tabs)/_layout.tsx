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

  // First-run GDPR opt-in: if the user hasn't answered the analytics prompt yet, show it as a
  // full screen before they use the app. Once that's decided, a second first-run gate: if Daily
  // Brew is flag-enabled and this account hasn't seen its intro yet, show that too. Runs after the
  // analytics gate resolves, not instead of / racing it.
  useEffect(() => {
    if (!user) return;
    hasAnalyticsDecision().then(async (decided) => {
      if (!decided) {
        router.replace('/analytics-consent' as Href);
        return;
      }
      // Onboarding is for genuinely NEW accounts. The "seen" flags below live in AsyncStorage,
      // which survives an app update and is wiped on uninstall - correct fresh-install semantics,
      // except for one case they can't cover: someone who already had the app and updates INTO
      // this build has never had the flag set either, so they'd be told to "capture your first
      // note" while sitting on a library of them.
      //
      // The signal for that is the ACCOUNT'S AGE, not what's in local storage. An earlier version
      // of this checked "does this device have any notes?", which was wrong: clearLocalData()
      // only runs on account deletion, never on logout, so a user who logged out and registered
      // a fresh account still had the previous account's notes on disk - and the whole flow was
      // silently skipped for a brand-new signup. created_at belongs to the account itself, so
      // switching accounts, logging out, or reinstalling can't confuse it.
      const voiceKey = `voice_onboarding_seen:${user.id}`;
      const liftKey = `daily_lift_onboarding_seen:${user.id}`;
      const [voiceSeenRaw, liftSeenRaw, reminderSeenRaw] = await Promise.all([
        AsyncStorage.getItem(voiceKey),
        AsyncStorage.getItem(liftKey),
        AsyncStorage.getItem(`reminder_voice_onboarding_seen:${user.id}`),
      ]);
      if (!voiceSeenRaw || !liftSeenRaw || !reminderSeenRaw) {
        const createdAt = user.created_at ? new Date(user.created_at).getTime() : NaN;
        const accountAgeMs = Number.isFinite(createdAt) ? Date.now() - createdAt : 0;
        // A week is generous for someone who registers and doesn't open the app for a few days,
        // while anyone whose account predates that is plainly not a first-time user. An
        // unparseable created_at falls through to showing onboarding rather than hiding it.
        if (accountAgeMs > 7 * 24 * 60 * 60 * 1000) {
          await AsyncStorage.multiSet([
            [voiceKey, '1'], [liftKey, '1'],
            [`reminder_voice_onboarding_seen:${user.id}`, '1'],
          ]).catch(() => {});
          return;
        }
      }

      // Voice onboarding comes first: its whole job is getting a first note captured by voice,
      // which is worth strictly more than a feature intro and shouldn't queue behind one.
      const voiceSeen = voiceSeenRaw;
      if (!voiceSeen) {
        router.replace('/voice-onboarding' as Href);
        return;
      }
      // The daily-lift step follows the first note. Deliberately NOT gated on
      // user.daily_brew_enabled: that flag is server-resolved and fails closed, so gating on it
      // meant the step could silently never appear - the toggles here are all client-side content
      // (verse/quote are bundled; news just stores a preference), so there's nothing to gate.
      // The dedicated daily-lift screen was merged into news-source-settings (one screen, two
      // modes) - `?onboarding=1` is what makes it the onboarding step, and it writes `liftKey`
      // itself on either Skip or confirm.
      if (!liftSeenRaw) {
        router.replace('/news-source-settings?onboarding=1' as Href);
        return;
      }
      // Reminder voice comes after the daily lift - both are "how do you want Nueco to reach you"
      // questions, and they read better together than split across the flow.
      const reminderVoiceSeen = await AsyncStorage.getItem(`reminder_voice_onboarding_seen:${user.id}`);
      if (!reminderVoiceSeen) {
        router.replace('/reminder-voice' as Href);
        return;
      }
      const onboardingSeen = await AsyncStorage.getItem(`daily_brew_onboarding_seen:${user.id}`);
      if (user.daily_brew_enabled && !onboardingSeen) router.replace('/daily-brew-intro' as Href);
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
