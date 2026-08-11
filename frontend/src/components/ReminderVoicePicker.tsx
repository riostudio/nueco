/**
 * Reminder voice options: pick a language, then one of three voices.
 *
 * Shared by the onboarding step (app/reminder-voice.tsx) and Settings, which reveals it inline
 * under its toggle - so both places behave identically and there is one implementation to keep
 * correct. Self-persisting: every change writes to REMINDER_VOICE_PREF_KEY, so Settings needs no
 * save button and onboarding's confirm button only has to navigate.
 *
 * WHY THERE IS NO "RECORD YOUR OWN VOICE"
 * It was removed deliberately. A recording is fixed audio - it can only ever say the words spoken
 * into the microphone, so it can never read out an event title. Making it do so would mean
 * synthesising the user's voice (voice cloning), which needs either a cloud service - sending a
 * voice model AND every event title off-device, the one thing this app exists to avoid - or an
 * on-device cloning model with no viable React Native implementation today.
 *
 * The device's own speech engine (AVSpeechSynthesizer / Google TTS) reads arbitrary text, runs
 * fully offline, and sends nothing anywhere.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView, ActivityIndicator, TextInput } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import * as Speech from 'expo-speech';
import * as Localization from 'expo-localization';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { C } from '../theme';

export const REMINDER_VOICE_PREF_KEY = 'reminder_voice_pref';
const SAMPLE_TEXT = 'Coffee with Sam at three, near the bridge.';
/** Surfaced per language. More than a handful becomes a list to wade through, not a choice. */
const VOICE_CHOICES = 3;

export type ReminderVoiceMode = 'off' | 'device';
type Voice = { identifier: string; name: string; language: string; quality?: string };

/**
 * Readable language name with the REGION SPELLED OUT.
 *
 * A raw tag like "en-ZA" or "es-419" says nothing about which country's accent is being chosen.
 * Rendered in the device's own language so the list reads consistently, rather than each row
 * appearing in its own language.
 */
function languageLabel(tag: string): string {
  const parts = tag.split(/[-_]/);
  const base = parts[0];
  // From index 1 deliberately: the language subtag is itself two letters, so scanning from the
  // start matches IT as the region - which rendered en-AU as "English (EN)" and, worse, pt-BR as
  // "Portuguese (Portugal)". Script subtags (Hans, Latn) are four letters and fail both patterns.
  const regionCode = parts.slice(1).find(p => /^[A-Za-z]{2}$/.test(p) || /^[0-9]{3}$/.test(p));

  let language = base;
  try {
    language = new (Intl as any).DisplayNames(undefined, { type: 'language' }).of(base) || base;
  } catch {
    // keep the raw subtag
  }
  if (!regionCode) return language;

  let region = regionCode.toUpperCase();
  try {
    region = new (Intl as any).DisplayNames(undefined, { type: 'region' }).of(regionCode.toUpperCase()) || region;
  } catch {
    // keep the raw code
  }
  return `${language} (${region})`;
}

/** Enhanced/premium voices sound markedly better than the compact defaults - rank those first. */
function byQuality(a: Voice, b: Voice): number {
  const rank = (v: Voice) => (/enhanced|premium/i.test(String(v.quality || '')) ? 0 : 1);
  return rank(a) - rank(b) || a.name.localeCompare(b.name);
}

export function ReminderVoicePicker({ onModeChange }: { onModeChange?: (m: ReminderVoiceMode) => void }) {
  const [voices, setVoices] = useState<Voice[]>([]);
  const [selectedVoice, setSelectedVoice] = useState<string | null>(null);
  const [selectedLanguage, setSelectedLanguage] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [speakingId, setSpeakingId] = useState<string | null>(null);
  const [langQuery, setLangQuery] = useState('');
  const [langOpen, setLangOpen] = useState(false);

  const languages = Array.from(new Set(voices.map(v => v.language))).sort();
  const choices = voices.filter(v => v.language === selectedLanguage).sort(byQuality).slice(0, VOICE_CHOICES);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const all = await Speech.getAvailableVoicesAsync();
        if (cancelled) return;
        const mapped = all
          .filter(v => typeof v.language === 'string' && v.language)
          .map(v => ({
            identifier: v.identifier,
            name: v.name || v.identifier,
            language: v.language,
            quality: (v as any).quality,
          }));
        const seen = new Set<string>();
        const unique = mapped.filter(v => {
          const k = `${v.name}|${v.language}`;
          return seen.has(k) ? false : (seen.add(k), true);
        });
        setVoices(unique);

        const deviceLang = (Localization.getLocales?.()[0]?.languageTag || 'en-US').toLowerCase();
        const langs = Array.from(new Set(unique.map(v => v.language)));
        setSelectedLanguage(
          langs.find(l => l.toLowerCase() === deviceLang)
          || langs.find(l => l.toLowerCase().split(/[-_]/)[0] === deviceLang.split(/[-_]/)[0])
          || langs[0] || null,
        );
      } catch {
        if (!cancelled) setVoices([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; Speech.stop(); };
  }, []);

  // Reflect what's already saved so this never looks unset when it isn't.
  useEffect(() => {
    AsyncStorage.getItem(REMINDER_VOICE_PREF_KEY).then(raw => {
      if (!raw) return;
      try {
        const p = JSON.parse(raw);
        if (p?.voiceId) setSelectedVoice(p.voiceId);
        if (p?.language) setSelectedLanguage(p.language);
      } catch {}
    }).catch(() => {});
  }, []);

  const persist = useCallback((voiceId: string | null, language: string | null) => {
    const mode: ReminderVoiceMode = voiceId ? 'device' : 'off';
    AsyncStorage.setItem(
      REMINDER_VOICE_PREF_KEY,
      JSON.stringify(mode === 'off' ? { mode: 'off' } : { mode, voiceId, language }),
    ).catch(() => {});
    onModeChange?.(mode);
  }, [onModeChange]);

  const choose = useCallback((voiceId: string) => {
    setSelectedVoice(voiceId);
    persist(voiceId, selectedLanguage);
  }, [persist, selectedLanguage]);

  const preview = useCallback((voiceId: string) => {
    Speech.stop();
    setSpeakingId(voiceId);
    Speech.speak(SAMPLE_TEXT, {
      voice: voiceId,
      onDone: () => setSpeakingId(null),
      onStopped: () => setSpeakingId(null),
      onError: () => setSpeakingId(null),
    });
  }, []);

  if (loading) {
    return (
      <View style={s.loadingRow}>
        <ActivityIndicator size="small" color={C.borderSub} />
        <Text style={s.hint}>Loading voices…</Text>
      </View>
    );
  }

  if (voices.length === 0) {
    return <Text style={s.hint}>No speech voices are installed on this device.</Text>;
  }

  return (
    <View>
      <Text style={s.groupLabel}>Language</Text>

      {/* Collapsed to the current choice: a device can expose 20-70 languages, so a flat list
          buries most of them with nothing to search by. */}
      <TouchableOpacity style={s.langCurrent} onPress={() => setLangOpen(o => !o)} activeOpacity={0.75} testID="language-selector">
        <MaterialIcons name="language" size={18} color={C.secondary} />
        <Text style={s.langCurrentText} numberOfLines={1}>
          {selectedLanguage ? languageLabel(selectedLanguage) : 'Choose a language'}
        </Text>
        <MaterialIcons name={langOpen ? 'expand-less' : 'expand-more'} size={20} color={C.borderSub} />
      </TouchableOpacity>

      {langOpen && (
        <View style={s.langPanel}>
          {languages.length > 6 && (
            <TextInput
              style={s.langSearch}
              value={langQuery}
              onChangeText={setLangQuery}
              placeholder="Search languages"
              placeholderTextColor={C.borderSub}
              autoCorrect={false}
              testID="language-search"
            />
          )}
          <ScrollView style={s.langList} nestedScrollEnabled keyboardShouldPersistTaps="handled">
            {languages
              .filter(l => {
                const q = langQuery.trim().toLowerCase();
                return !q || languageLabel(l).toLowerCase().includes(q) || l.toLowerCase().includes(q);
              })
              .map(lang => {
                const on = lang === selectedLanguage;
                return (
                  <TouchableOpacity
                    key={lang}
                    style={s.langRow}
                    onPress={() => {
                      setSelectedLanguage(lang);
                      // The chosen voice belongs to the previous language - clear it so the user
                      // picks again rather than silently keeping a mismatched voice.
                      setSelectedVoice(null);
                      persist(null, lang);
                      setLangOpen(false);
                      setLangQuery('');
                    }}
                    activeOpacity={0.75}
                  >
                    <MaterialIcons name={on ? 'radio-button-checked' : 'radio-button-unchecked'} size={17} color={on ? C.secondary : C.borderSub} />
                    <Text style={[s.langRowText, on && s.langRowTextOn]} numberOfLines={1}>{languageLabel(lang)}</Text>
                  </TouchableOpacity>
                );
              })}
          </ScrollView>
        </View>
      )}

      <Text style={s.groupLabel}>Voice</Text>
      {choices.length === 0 ? (
        <Text style={s.hint}>No voices for this language.</Text>
      ) : (
        choices.map(v => {
          const on = v.identifier === selectedVoice;
          const enhanced = /enhanced|premium/i.test(String(v.quality || ''));
          return (
            <TouchableOpacity
              key={v.identifier}
              style={[s.voiceCard, on && s.voiceCardOn]}
              onPress={() => choose(v.identifier)}
              activeOpacity={0.8}
              testID={`voice-${v.identifier}`}
            >
              <MaterialIcons name={on ? 'radio-button-checked' : 'radio-button-unchecked'} size={20} color={on ? C.secondary : C.borderSub} />
              <View style={s.voiceBody}>
                <Text style={[s.voiceName, on && s.voiceNameOn]} numberOfLines={1}>{v.name}</Text>
                {enhanced && <Text style={s.voiceTag}>Higher quality</Text>}
              </View>
              <TouchableOpacity onPress={() => preview(v.identifier)} hitSlop={10} testID={`preview-${v.identifier}`}>
                <MaterialIcons
                  name={speakingId === v.identifier ? 'graphic-eq' : 'volume-up'}
                  size={21}
                  color={speakingId === v.identifier ? C.secondary : C.borderSub}
                />
              </TouchableOpacity>
            </TouchableOpacity>
          );
        })
      )}
      <Text style={s.hint}>Tap the speaker to hear each one.</Text>
    </View>
  );
}

const s = StyleSheet.create({
  groupLabel: {
    fontSize: 11, fontWeight: '700', color: C.borderSub,
    letterSpacing: 0.8, textTransform: 'uppercase', marginTop: 18, marginBottom: 8,
  },
  hint: { fontSize: 12, color: C.textSec, lineHeight: 17, marginTop: 8 },
  loadingRow: { flexDirection: 'row', alignItems: 'center', gap: 9, paddingVertical: 10 },

  langCurrent: {
    flexDirection: 'row', alignItems: 'center', gap: 9,
    backgroundColor: C.surface, borderRadius: 10, borderWidth: 1, borderColor: C.border,
    paddingVertical: 11, paddingHorizontal: 12,
  },
  langCurrentText: { flex: 1, fontSize: 14, color: C.text, fontWeight: '600' },
  langPanel: {
    backgroundColor: C.surface, borderRadius: 10, borderWidth: 1, borderColor: C.border,
    marginTop: 6, overflow: 'hidden',
  },
  langSearch: {
    fontSize: 14, color: C.text, paddingHorizontal: 12, paddingVertical: 10,
    borderBottomWidth: 1, borderBottomColor: C.border,
  },
  langList: { maxHeight: 220 },
  langRow: { flexDirection: 'row', alignItems: 'center', gap: 9, paddingVertical: 10, paddingHorizontal: 12 },
  langRowText: { flex: 1, fontSize: 14, color: C.textSec },
  langRowTextOn: { color: C.text, fontWeight: '600' },

  voiceCard: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    backgroundColor: C.surface, borderRadius: 12,
    paddingVertical: 14, paddingHorizontal: 14, marginBottom: 9,
    shadowColor: '#0A5443', shadowOpacity: 0.05, shadowRadius: 5, shadowOffset: { width: 0, height: 1 },
    elevation: 1,
  },
  voiceCardOn: { backgroundColor: C.surfaceHi },
  voiceBody: { flex: 1, gap: 2 },
  voiceName: { fontSize: 15, color: C.textSec },
  voiceNameOn: { color: C.text, fontWeight: '600' },
  voiceTag: { fontSize: 11, color: C.secondary, fontWeight: '600' },
});
