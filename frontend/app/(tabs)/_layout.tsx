import { Tabs } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { StyleSheet, View, Alert } from 'react-native';
import React, { useState } from 'react';
import { UserAvatar, useAuth, LinkAccountBottomSheet } from '../../src/auth';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

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

function SettingsIcon({ color }: { color: string }) {
  return <MaterialIcons name="settings" size={22} color={color} />;
}

function HeaderRight({ onSignInPress, onLogout }: { onSignInPress: () => void; onLogout: () => void }) {
  const { user } = useAuth();
  return (
    <View style={styles.headerRight}>
      <UserAvatar 
        user={user} 
        size={36} 
        onSignInPress={onSignInPress}
        onLogout={onLogout}
      />
    </View>
  );
}

export default function TabLayout() {
  const [showSignInSheet, setShowSignInSheet] = useState(false);
  const { logout, refreshUser } = useAuth();

  const handleSignInPress = () => {
    setShowSignInSheet(true);
  };

  const handleLogout = () => {
    Alert.alert(
      'Log Out',
      'Are you sure you want to log out? Your local notes will be kept.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Log Out',
          style: 'destructive',
          onPress: async () => {
            await logout();
          },
        },
      ]
    );
  };

  const handleSignInSuccess = async () => {
    await refreshUser();
  };

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <Tabs
        screenOptions={{
          headerShown: true,
          headerStyle: styles.header,
          headerTitleStyle: styles.headerTitle,
          headerRight: () => (
            <HeaderRight 
              onSignInPress={handleSignInPress} 
              onLogout={handleLogout}
            />
          ),
          tabBarStyle: styles.tabBar,
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
            title: 'Settings',
            tabBarIcon: SettingsIcon,
          }}
        />
      </Tabs>
      
      {/* Sign In Bottom Sheet */}
      <LinkAccountBottomSheet
        isVisible={showSignInSheet}
        onDismiss={() => setShowSignInSheet(false)}
        onSuccess={handleSignInSuccess}
      />
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
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
