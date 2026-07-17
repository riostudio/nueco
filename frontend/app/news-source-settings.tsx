import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, Switch, ActivityIndicator,
  Alert, Modal, Pressable, Platform, TextInput, KeyboardAvoidingView,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { MaterialIcons } from '@expo/vector-icons';
import { useRouter, useLocalSearchParams, type Href } from 'expo-router';
import { dailyBrewApi } from '../src/api';
import { getVerseForDate } from '../src/dailyBrew/verses';
import { C, radius, TAG_COLORS } from '../src/theme';

let ExpoLocation: typeof import('expo-location') | null = null;
if (Platform.OS !== 'web') {
  try { ExpoLocation = require('expo-location'); } catch {}
}

type Outlet = { id: string; name: string; description?: string; topics?: string[] };

// Curated country list for v1's "Change" picker. Mirrors backend/dailybrew/catalog.py's keys -
// hardcoded here because that module hadn't landed yet when this screen was built. Reconcile
// against the real catalog once it exists (should just be AU/ID at launch either way).
const CURATED_COUNTRIES = [
  { code: 'AU', name: 'Australia' },
  { code: 'ID', name: 'Indonesia' },
];

type LocationState = 'loading' | 'granted' | 'denied' | 'error';

// Deterministic string -> index, so each outlet gets a stable (not random-per-render) avatar
// color from the app's existing tag palette instead of fetching a real logo.
function hashIndex(str: string): number {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
  return h;
}

export default function NewsSourceSettingsScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ onboarding?: string }>();
  const isOnboarding = params.onboarding === '1';

  const [verseEnabled, setVerseEnabled] = useState(false);
  const [locationState, setLocationState] = useState<LocationState>('loading');
  const [detectedPlace, setDetectedPlace] = useState<{ city?: string; country?: string } | null>(null);
  const [countryCode, setCountryCode] = useState<string | null>(null);
  const [outlets, setOutlets] = useState<Outlet[]>([]);
  const [selectedOutletIds, setSelectedOutletIds] = useState<string[]>([]);
  const [loadingOutlets, setLoadingOutlets] = useState(false);
  const [showCountryPicker, setShowCountryPicker] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<Outlet[]>([]);
  const [searching, setSearching] = useState(false);

  const todayVerse = useMemo(() => getVerseForDate(new Date()), []);

  const detectLocation = useCallback(async () => {
    setLocationState('loading');
    if (!ExpoLocation || Platform.OS === 'web') {
      setLocationState('denied');
      return;
    }
    try {
      const { status } = await ExpoLocation.requestForegroundPermissionsAsync();
      if (status !== 'granted') {
        setLocationState('denied');
        return;
      }
      const pos = await ExpoLocation.getCurrentPositionAsync({ accuracy: ExpoLocation.Accuracy.Balanced });
      const [place] = await ExpoLocation.reverseGeocodeAsync({
        latitude: pos.coords.latitude,
        longitude: pos.coords.longitude,
      });
      if (!place || !place.isoCountryCode) {
        setLocationState('error');
        return;
      }
      setDetectedPlace({ city: place.city ?? undefined, country: place.country ?? undefined });
      setCountryCode(place.isoCountryCode);
      setLocationState('granted');
    } catch (e) {
      console.error('Failed to detect location for Daily Brew:', e);
      setLocationState('error');
    }
  }, []);

  useEffect(() => { detectLocation(); }, [detectLocation]);

  useEffect(() => {
    if (!countryCode) return;
    (async () => {
      setLoadingOutlets(true);
      try {
        const res = await dailyBrewApi.getNewsSources(countryCode);
        const list: Outlet[] = res?.outlets ?? [];
        setOutlets(list);
        setSelectedOutletIds(list.slice(0, 2).map((o) => o.id));
      } catch (e) {
        console.error('Failed to load news sources:', e);
        setOutlets([]);
        setSelectedOutletIds([]);
      } finally {
        setLoadingOutlets(false);
      }
    })();
  }, [countryCode]);

  const toggleOutlet = useCallback((id: string) => {
    setSelectedOutletIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }, []);

  // Debounced topic-feed search - typing "AI news" surfaces specific suggested feeds to
  // follow (e.g. TechCrunch AI), not a keyword filter over already-selected outlets' headlines.
  useEffect(() => {
    const q = searchQuery.trim();
    if (q.length < 2) {
      setSearchResults([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    const timer = setTimeout(async () => {
      try {
        const results = await dailyBrewApi.searchFeeds(q);
        setSearchResults(results ?? []);
      } catch (e) {
        console.error('Failed to search news feeds:', e);
        setSearchResults([]);
      } finally {
        setSearching(false);
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  const selectCountry = useCallback((code: string) => {
    setShowCountryPicker(false);
    setDetectedPlace(null);
    setCountryCode(code);
  }, []);

  const canConfirm = selectedOutletIds.length > 0 || verseEnabled;

  const goToDestination = useCallback(() => {
    if (isOnboarding) router.replace('/(tabs)');
    else router.back();
  }, [isOnboarding, router]);

  const handleConfirm = useCallback(async () => {
    if (!canConfirm || confirming) return;
    setConfirming(true);
    try {
      await dailyBrewApi.updateNewsPreferences(countryCode || '', selectedOutletIds, verseEnabled);
      goToDestination();
    } catch (e) {
      console.error('Failed to save news preferences:', e);
      Alert.alert('Daily Brew', 'Could not save your preferences. Please try again.');
    } finally {
      setConfirming(false);
    }
  }, [canConfirm, confirming, countryCode, selectedOutletIds, verseEnabled, goToDestination]);

  const handleSkip = useCallback(() => {
    router.replace('/(tabs)');
  }, [router]);

  return (
    <SafeAreaView style={s.container}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
      <View style={s.header}>
        {isOnboarding ? (
          <TouchableOpacity testID="news-settings-skip-btn" onPress={handleSkip} style={s.skipBtn}>
            <Text style={s.skipText}>Skip for now</Text>
          </TouchableOpacity>
        ) : (
          <TouchableOpacity onPress={() => router.back()} style={s.backBtn}>
            <MaterialIcons name="arrow-back" size={28} color={C.textSec} />
          </TouchableOpacity>
        )}
        <Text style={s.headerTitle}>News from home</Text>
        <View style={{ width: 48 }} />
      </View>

      <ScrollView style={s.scroll} contentContainerStyle={s.scrollContent}>
        <View style={[s.card, s.toggleCard]}>
          <View style={s.toggleRow}>
            <MaterialIcons name="menu-book" size={24} color={C.textSec} />
            <View style={{ flex: 1, marginLeft: 16 }}>
              <Text style={s.rowLabelPlain}>Include Bible verse in your Daily Brew</Text>
              <Text style={s.rowSub}>A short verse each day, alongside your news.</Text>
            </View>
            <Switch
              testID="verse-toggle"
              value={verseEnabled}
              onValueChange={setVerseEnabled}
              trackColor={{ false: C.borderSub, true: C.primary + '80' }}
              thumbColor={verseEnabled ? C.primary : '#f4f3f4'}
            />
          </View>
          {verseEnabled && (
            <View style={s.versePreview}>
              <Text style={s.versePreviewText} numberOfLines={2}>&ldquo;{todayVerse.text}&rdquo;</Text>
              <Text style={s.versePreviewRef}>{todayVerse.reference}</Text>
            </View>
          )}
        </View>

        <View style={[s.card, { marginTop: 20 }]}>
          <Text style={s.sectionLabel}>News sources</Text>

          {countryCode ? (
            <View style={s.banner}>
              <MaterialIcons name="location-on" size={18} color={C.textSec} />
              <Text style={s.bannerText} numberOfLines={1}>
                {detectedPlace
                  ? `Detected: ${[detectedPlace.city, detectedPlace.country].filter(Boolean).join(', ')}`
                  : `Selected: ${CURATED_COUNTRIES.find((c) => c.code === countryCode)?.name ?? countryCode}`}
              </Text>
              <TouchableOpacity onPress={() => setShowCountryPicker(true)}>
                <Text style={s.changeLink}>Change</Text>
              </TouchableOpacity>
            </View>
          ) : locationState === 'loading' ? (
            <View style={s.center}><ActivityIndicator size="small" color={C.primary} /></View>
          ) : (
            <View style={s.banner}>
              <Text style={[s.bannerText, { flex: 1 }]}>
                Couldn&apos;t detect your location — try &quot;Change&quot; below to pick manually.
              </Text>
              <TouchableOpacity onPress={() => setShowCountryPicker(true)}>
                <Text style={s.changeLink}>Change</Text>
              </TouchableOpacity>
            </View>
          )}

          {countryCode && (
            loadingOutlets ? (
              <View style={s.center}><ActivityIndicator size="small" color={C.primary} /></View>
            ) : outlets.length === 0 ? (
              <Text style={s.rowSub}>No outlets available for this country yet.</Text>
            ) : (
              outlets.map((outlet) => {
                const selected = selectedOutletIds.includes(outlet.id);
                const avatarColor = TAG_COLORS[hashIndex(outlet.id) % TAG_COLORS.length].value;
                return (
                  <TouchableOpacity
                    key={outlet.id}
                    testID={`news-outlet-${outlet.id}`}
                    style={s.row}
                    onPress={() => toggleOutlet(outlet.id)}
                  >
                    <View style={[s.outletAvatar, { backgroundColor: avatarColor }]}>
                      <Text style={s.outletAvatarLetter}>{outlet.name.charAt(0).toUpperCase()}</Text>
                    </View>
                    <View style={{ flex: 1, marginLeft: 12 }}>
                      <Text style={s.rowLabelPlain}>{outlet.name}</Text>
                      {!!outlet.description && (
                        <Text style={s.rowSub} numberOfLines={1}>{outlet.description}</Text>
                      )}
                    </View>
                    <MaterialIcons
                      name={selected ? 'check-box' : 'check-box-outline-blank'}
                      size={24}
                      color={selected ? C.primary : C.borderSub}
                    />
                  </TouchableOpacity>
                );
              })
            )
          )}
        </View>

        <View style={[s.card, { marginTop: 20 }]}>
          <Text style={s.sectionLabel}>Search by topic</Text>
          <Text style={[s.rowSub, { marginBottom: 12 }]}>
            Try &quot;AI news,&quot; &quot;food,&quot; or &quot;global news&quot; to find feeds to follow.
          </Text>
          <View style={s.searchBox}>
            <MaterialIcons name="search" size={20} color={C.borderSub} />
            <TextInput
              testID="news-topic-search-input"
              style={s.searchInput}
              placeholder="Search topics..."
              placeholderTextColor={C.borderSub}
              value={searchQuery}
              onChangeText={setSearchQuery}
              autoCapitalize="none"
            />
            {searching && <ActivityIndicator size="small" color={C.primary} />}
          </View>

          {searchResults.map((outlet) => {
            const following = selectedOutletIds.includes(outlet.id);
            const avatarColor = TAG_COLORS[hashIndex(outlet.id) % TAG_COLORS.length].value;
            return (
              <View key={outlet.id} testID={`news-search-result-${outlet.id}`} style={s.row}>
                <View style={[s.outletAvatar, { backgroundColor: avatarColor }]}>
                  <Text style={s.outletAvatarLetter}>{outlet.name.charAt(0).toUpperCase()}</Text>
                </View>
                <View style={{ flex: 1, marginLeft: 12 }}>
                  <Text style={s.rowLabelPlain}>{outlet.name}</Text>
                  {!!outlet.description && (
                    <Text style={s.rowSub} numberOfLines={1}>{outlet.description}</Text>
                  )}
                </View>
                <TouchableOpacity
                  testID={`news-search-follow-${outlet.id}`}
                  style={[s.followBtn, following && s.followBtnActive]}
                  onPress={() => toggleOutlet(outlet.id)}
                >
                  <Text style={[s.followBtnText, following && s.followBtnTextActive]}>
                    {following ? 'Following' : 'Follow'}
                  </Text>
                </TouchableOpacity>
              </View>
            );
          })}

          {searchQuery.trim().length >= 2 && !searching && searchResults.length === 0 && (
            <Text style={s.rowSub}>No feeds found for &quot;{searchQuery.trim()}.&quot;</Text>
          )}
        </View>

        <TouchableOpacity
          testID="news-settings-confirm-btn"
          style={[s.confirmBtn, (!canConfirm || confirming) && s.confirmBtnDisabled]}
          onPress={handleConfirm}
          disabled={!canConfirm || confirming}
        >
          {confirming
            ? <ActivityIndicator size="small" color={C.primaryFg} />
            : <Text style={s.confirmBtnText}>Confirm</Text>}
        </TouchableOpacity>

        <View style={{ height: 40 }} />
      </ScrollView>
      </KeyboardAvoidingView>

      <Modal
        visible={showCountryPicker}
        transparent
        animationType="fade"
        onRequestClose={() => setShowCountryPicker(false)}
      >
        <Pressable style={s.modalOverlay} onPress={() => setShowCountryPicker(false)}>
          <View style={s.pickerCard}>
            <Text style={s.sectionLabel}>Choose a country</Text>
            {CURATED_COUNTRIES.map((c) => (
              <TouchableOpacity key={c.code} style={s.row} onPress={() => selectCountry(c.code)}>
                <MaterialIcons name="public" size={22} color={C.textSec} />
                <Text style={s.rowLabel}>{c.name}</Text>
                {countryCode === c.code && <MaterialIcons name="check" size={20} color={C.primary} />}
              </TouchableOpacity>
            ))}
          </View>
        </Pressable>
      </Modal>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg },
  center: { paddingVertical: 12, alignItems: 'center' },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingTop: 12,
    paddingBottom: 12,
  },
  backBtn: { padding: 12 },
  skipBtn: { paddingHorizontal: 12, paddingVertical: 12 },
  skipText: { fontSize: 16, fontWeight: '600', color: C.primary },
  headerTitle: { fontSize: 22, fontWeight: '700', color: C.text },
  scroll: { flex: 1 },
  scrollContent: { paddingHorizontal: 24, paddingTop: 8 },
  card: { backgroundColor: C.surface, padding: 20 },
  toggleCard: { paddingVertical: 24, paddingHorizontal: 24 },
  sectionLabel: { fontSize: 16, fontWeight: '600', color: C.textSec, marginBottom: 12 },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10 },
  toggleRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 8, paddingHorizontal: 4 },
  rowLabel: { fontSize: 18, color: C.text, marginLeft: 16, flex: 1, fontWeight: '500' },
  rowLabelPlain: { fontSize: 18, color: C.text },
  rowSub: { fontSize: 14, color: C.textSec, marginTop: 6, lineHeight: 20 },
  banner: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingVertical: 10, marginBottom: 8,
  },
  bannerText: { fontSize: 14, color: C.textSec, flexShrink: 1 },
  changeLink: { fontSize: 14, fontWeight: '600', color: C.primary, marginLeft: 'auto' },
  versePreview: { marginTop: 16, paddingTop: 16, borderTopWidth: 1, borderTopColor: C.borderSub + '30' },
  versePreviewText: { fontSize: 15, color: C.text, fontStyle: 'italic', lineHeight: 22 },
  versePreviewRef: { fontSize: 13, color: C.primary, marginTop: 6, fontWeight: '600' },
  outletAvatar: {
    width: 36, height: 36, borderRadius: 18, justifyContent: 'center', alignItems: 'center',
  },
  outletAvatarLetter: { color: '#FFFFFF', fontSize: 16, fontWeight: '700' },
  searchBox: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: C.bg, borderRadius: radius.md, borderWidth: 1.5, borderColor: C.border,
    paddingHorizontal: 12, height: 48, marginBottom: 8,
  },
  searchInput: { flex: 1, fontSize: 15, color: C.text },
  followBtn: {
    borderRadius: radius.pill, borderWidth: 1.5, borderColor: C.primary,
    paddingHorizontal: 14, paddingVertical: 7,
  },
  followBtnActive: { backgroundColor: C.primary },
  followBtnText: { fontSize: 13, fontWeight: '700', color: C.primary },
  followBtnTextActive: { color: C.primaryFg },
  confirmBtn: {
    marginTop: 24, backgroundColor: C.primary, borderRadius: radius.md,
    paddingVertical: 16, alignItems: 'center', justifyContent: 'center',
  },
  confirmBtnDisabled: { backgroundColor: C.borderSub },
  confirmBtnText: { fontSize: 16, fontWeight: '700', color: C.primaryFg },
  modalOverlay: {
    flex: 1, backgroundColor: 'rgba(0, 0, 0, 0.3)', justifyContent: 'center', alignItems: 'center',
    paddingHorizontal: 32,
  },
  pickerCard: {
    backgroundColor: C.surface, borderRadius: radius.lg, padding: 20, width: '100%',
  },
});
