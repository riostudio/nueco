import { Tabs } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { StyleSheet } from 'react-native';
import React from 'react';

const C = {
  primary: '#D84315',
  textSecondary: '#37474F',
  surface: '#FFFFFF',
  border: '#121212',
};

function NotesIcon({ color }: { color: string }) {
  return <MaterialIcons name="description" size={28} color={color} />;
}

function CalendarIcon({ color }: { color: string }) {
  return <MaterialIcons name="calendar-today" size={28} color={color} />;
}

function SettingsIcon({ color }: { color: string }) {
  return <MaterialIcons name="settings" size={28} color={color} />;
}

export default function TabLayout() {
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarStyle: styles.tabBar,
        tabBarActiveTintColor: C.primary,
        tabBarInactiveTintColor: C.textSecondary,
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
    height: 88,
    paddingTop: 8,
    paddingBottom: 20,
    backgroundColor: C.surface,
    borderTopWidth: 2,
    borderTopColor: C.border,
  },
  tabLabel: {
    fontSize: 16,
    fontWeight: '600',
    marginTop: 2,
  },
});
