import { Tabs } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { StyleSheet } from 'react-native';
import React from 'react';

const C = {
  primary: '#D84315',
  inactiveTab: '#757575', // Accessible grey (WCAG AA compliant)
  surface: '#FFFFFF',
  border: '#121212',
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

export default function TabLayout() {
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
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
  );
}

const styles = StyleSheet.create({
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
