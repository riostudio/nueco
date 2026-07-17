import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { MaterialIcons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { getVerseForDate } from '../src/dailyBrew/verses';
import { C, typography } from '../src/theme';

export default function DailyVerseScreen() {
  const router = useRouter();
  const verse = getVerseForDate(new Date());

  return (
    <SafeAreaView style={s.container}>
      <View style={s.header}>
        <TouchableOpacity onPress={() => router.back()} style={s.closeBtn}>
          <MaterialIcons name="close" size={28} color={C.textSec} />
        </TouchableOpacity>
      </View>

      <View style={s.content}>
        <MaterialIcons name="menu-book" size={32} color={C.primary} style={s.icon} />
        <Text style={s.verseText}>{verse.text}</Text>
        <Text style={s.verseRef}>{verse.reference}</Text>
      </View>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg },
  header: { flexDirection: 'row', justifyContent: 'flex-end', paddingHorizontal: 8, paddingTop: 12 },
  closeBtn: { padding: 12 },
  content: { flex: 1, paddingHorizontal: 28, justifyContent: 'center' },
  icon: { alignSelf: 'center', marginBottom: 20 },
  verseText: { ...typography.h3, color: C.text, textAlign: 'center' },
  verseRef: { ...typography.caption, color: C.primary, textAlign: 'center', marginTop: 20 },
});
