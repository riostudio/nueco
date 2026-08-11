/**
 * Daily Brew setup — the single screen for everything the morning card can contain.
 *
 * This replaces the old pair of screens (daily-lift.tsx for onboarding, news-source-settings.tsx
 * for settings), which covered overlapping ground and had already drifted: the daily quote could
 * be switched ON during onboarding and then never switched off again, because the settings screen
 * had no row for it. One screen, two modes (`?onboarding=1`), so a row added here can only ever
 * exist in both places at once.
 *
 * Shape: three toggles, each of which reveals its own section when on and hides it when off.
 * The country/source/topic pickers are meaningless to someone who doesn't want news, and showing
 * them upfront turns a yes/no question into a configuration screen. There is deliberately no
 * separate "your morning" composite preview - with today's verse under the verse toggle, today's
 * quote under the quote toggle, and the followed sources under News, it would restate the same
 * content a second time on the same screen.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, Switch, ActivityIndicator,
  Alert, Modal, Pressable, Platform, TextInput, KeyboardAvoidingView,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { MaterialIcons } from '@expo/vector-icons';
import { useRouter, useLocalSearchParams, type Href } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { dailyBrewApi } from '../src/api';
import { useAuth } from '../src/auth';
import { getVerseForDate } from '../src/dailyBrew/verses';
import { getQuoteForDate } from '../src/dailyBrew/quotes';
import { trackOnboardingStep } from '../src/analytics';
import { C, radius, TAG_COLORS } from '../src/theme';

let ExpoLocation: typeof import('expo-location') | null = null;
if (Platform.OS !== 'web') {
  try { ExpoLocation = require('expo-location'); } catch {}
}

type Outlet = { id: string; name: string; description?: string; topics?: string[] };

// Read by the onboarding gate in app/(tabs)/_layout.tsx to decide whether this step still needs
// showing. Written on the way out of onboarding (confirm OR skip) - skipping still counts as
// answering the question, and not writing it would put the user straight back here next launch.
const DAILY_LIFT_SEEN_PREFIX = 'daily_lift_onboarding_seen';

// Curated country list for v1's "Change" picker. Mirrors backend/dailybrew/catalog.py's keys -
// hardcoded here because that module hadn't landed yet when this screen was built. Reconcile
// against the real catalog once it exists (should just be AU/ID at launch either way).
// Daily Brew always shows 3 headlines, distributed across whatever's followed (see
// get_headlines_for_user in backend/dailybrew/service.py) - that distribution is specifically
// designed around 1-3 sources, so the follow list is capped to match.
const MAX_OUTLETS = 3;

const CURATED_COUNTRIES = [
  { code: 'AU', name: 'Australia' },
  { code: 'ID', name: 'Indonesia' },
];

// Where onboarding starts before the user picks. Onboarding never runs GPS detection (see the
// detection effect), so it needs a country to show sources for straight away.
const ONBOARDING_DEFAULT_COUNTRY = 'AU';

type LocationState = 'loading' | 'granted' | 'denied' | 'error';

// Deterministic string -> index, so each outlet gets a stable (not random-per-render) avatar
// color from the app's existing tag palette instead of fetching a real logo.
function hashIndex(str: string): number {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
  return h;
}

// fetchApi (src/api.ts) throws `Error("API Error 400: {\"detail\":\"...\"}")` - pull the
// backend's actual validation message back out for display, rather than a generic fallback.
function extractErrorDetail(e: unknown, fallback: string): string {
  if (e instanceof Error) {
    const match = e.message.match(/API Error \d+: (.*)/s);
    if (match) {
      try {
        const parsed = JSON.parse(match[1]);
        if (typeof parsed?.detail === 'string') return parsed.detail;
      } catch {}
    }
  }
  return fallback;
}

export default function NewsSourceSettingsScreen() {
  const router = useRouter();
  const { user, updateNewsPreferences } = useAuth();
  const params = useLocalSearchParams<{ onboarding?: string; news?: string }>();
  const isOnboarding = params.onboarding === '1';
  // Set by entry points that exist specifically to configure news (DailyBrewCard's "Set up News
  // from home" row) - they should never land on a screen with the News toggle off.
  const forceNewsOn = params.news === '1';
  // Editing already-saved preferences (reached via the avatar menu or the card's setup row, not
  // onboarding) - drives whether we hydrate from `user` instead of GPS-detecting a country and
  // defaulting picks.
  const hasExistingPrefs = Boolean(user?.news_outlet_ids?.length);
  // "Has this account ever answered this screen?" - distinguishes a first run (where the toggles
  // want inviting defaults) from someone who deliberately switched things OFF and saved. Without
  // it, turning news off and coming back would default it on again and quietly re-enable it.
  const hasAnySavedPref = hasExistingPrefs
    || user?.daily_brew_show_verse === true
    || user?.daily_brew_show_quote === true;

  const [verseEnabled, setVerseEnabled] = useState(user?.daily_brew_show_verse === true || !hasAnySavedPref);
  const [quoteEnabled, setQuoteEnabled] = useState(user?.daily_brew_show_quote === true);
  const [newsEnabled, setNewsEnabled] = useState(forceNewsOn || hasExistingPrefs || !hasAnySavedPref);
  const [locationState, setLocationState] = useState<LocationState>('loading');
  const [detectedPlace, setDetectedPlace] = useState<{ city?: string; country?: string } | null>(null);
  const [countryCode, setCountryCode] = useState<string | null>(
    user?.news_country ?? (isOnboarding ? ONBOARDING_DEFAULT_COUNTRY : null),
  );
  const [outlets, setOutlets] = useState<Outlet[]>([]);
  const [selectedOutletIds, setSelectedOutletIds] = useState<string[]>(user?.news_outlet_ids ?? []);
  // Every outlet we've ever seen full details for this screen-visit (country list, search
  // results, or the by-id lookup below) - keyed by id, so "Following" can show a name for a
  // selection that's no longer part of the current search results or country list.
  const [outletDetails, setOutletDetails] = useState<Record<string, Outlet>>({});
  const [loadingOutlets, setLoadingOutlets] = useState(false);
  const [showCountryPicker, setShowCountryPicker] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<Outlet[]>([]);
  const latestSearchQueryRef = useRef('');
  const [searching, setSearching] = useState(false);
  const [customFeedUrl, setCustomFeedUrl] = useState('');
  const [addingCustomFeed, setAddingCustomFeed] = useState(false);
  const [customFeedError, setCustomFeedError] = useState('');

  const todayVerse = useMemo(() => getVerseForDate(new Date()), []);

  const todayQuote = useMemo(() => getQuoteForDate(new Date()), []);

  const rememberOutlets = useCallback((list: Outlet[]) => {
    if (list.length === 0) return;
    setOutletDetails((prev) => {
      const next = { ...prev };
      for (const o of list) next[o.id] = o;
      return next;
    });
  }, []);

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

  useEffect(() => {
    // No news, no reason to ask where the user is.
    if (!newsEnabled) return;
    // Onboarding deliberately never prompts for location: this step follows the microphone
    // permission prompt, and stacking a second system dialog into onboarding is a good way to
    // have both denied. ONBOARDING_DEFAULT_COUNTRY is close enough for a default that "Change"
    // (and this screen, reopened from settings later) can correct.
    if (isOnboarding) return;
    // Already have a saved country? Skip GPS detection entirely rather than let it race with
    // (and potentially overwrite) the preference the user already chose.
    if (user?.news_country) { setLocationState('granted'); return; }
    detectLocation();
  }, [newsEnabled, isOnboarding, detectLocation, user?.news_country]);

  // Hydrate full display details for any already-selected ids that aren't covered by the
  // country list or a search - otherwise "Following" would have ids with no name to show for
  // topic-pool feeds followed in a previous session.
  useEffect(() => {
    const ids = user?.news_outlet_ids ?? [];
    if (ids.length === 0) return;
    dailyBrewApi.getOutletsByIds(ids).then(rememberOutlets).catch((e) => {
      console.error('Failed to load details for saved news outlets:', e);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!countryCode || !newsEnabled) return;
    (async () => {
      setLoadingOutlets(true);
      try {
        const res = await dailyBrewApi.getNewsSources(countryCode);
        const list: Outlet[] = res?.outlets ?? [];
        setOutlets(list);
        rememberOutlets(list);
        // "Default to the first 2" is a first-run convenience - never apply it once the user
        // has (or already had) real selections, or it'll silently wipe them out.
        setSelectedOutletIds((prev) => (prev.length === 0 && !hasExistingPrefs ? list.slice(0, 2).map((o) => o.id) : prev));
      } catch (e) {
        console.error('Failed to load news sources:', e);
        setOutlets([]);
      } finally {
        setLoadingOutlets(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [countryCode, newsEnabled]);

  const toggleOutlet = useCallback((id: string) => {
    setSelectedOutletIds((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id);
      if (prev.length >= MAX_OUTLETS) {
        Alert.alert('Following limit reached', `You can follow up to ${MAX_OUTLETS} news sources. Unfollow one first to add another.`);
        return prev;
      }
      return [...prev, id];
    });
  }, []);

  // Debounced topic-feed search - typing "AI news" surfaces specific suggested feeds to
  // follow (e.g. TechCrunch AI), not a keyword filter over already-selected outlets' headlines.
  useEffect(() => {
    const q = searchQuery.trim();
    // Cleanup only cancels the pending debounce timer, not an already-in-flight fetch - if an
    // earlier (slower) search resolves after a later (faster) one, its stale results would
    // overwrite the correct, newer ones with nothing to stop it. Guard with the latest query so
    // a response for anything other than the current search query is silently dropped.
    latestSearchQueryRef.current = q;
    if (q.length < 2) {
      setSearchResults([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    const timer = setTimeout(async () => {
      try {
        const results = await dailyBrewApi.searchFeeds(q);
        if (latestSearchQueryRef.current !== q) return; // stale - a newer search superseded this one
        setSearchResults(results ?? []);
        rememberOutlets(results ?? []);
      } catch (e) {
        if (latestSearchQueryRef.current !== q) return;
        console.error('Failed to search news feeds:', e);
        setSearchResults([]);
      } finally {
        if (latestSearchQueryRef.current === q) setSearching(false);
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  const handleAddCustomFeed = useCallback(async () => {
    const url = customFeedUrl.trim();
    if (!url || addingCustomFeed) return;
    // No pre-check against selectedOutletIds here (a useCallback dep on it would let the
    // MAX_OUTLETS guard run against a stale snapshot whenever the selection changed without
    // customFeedUrl also changing - see toggleOutlet, which has the same "check + alert inside
    // the functional updater" shape for the same reason: it always sees live state).
    setAddingCustomFeed(true);
    setCustomFeedError('');
    try {
      const outlet = await dailyBrewApi.addCustomFeed(url);
      rememberOutlets([outlet]);
      let blocked = false;
      setSelectedOutletIds((prev) => {
        if (prev.includes(outlet.id)) return prev;
        if (prev.length >= MAX_OUTLETS) { blocked = true; return prev; }
        return [...prev, outlet.id];
      });
      if (blocked) {
        Alert.alert('Following limit reached', `You can follow up to ${MAX_OUTLETS} news sources. Unfollow one first to add another.`);
      } else {
        setCustomFeedUrl('');
      }
    } catch (e) {
      console.error('Failed to add custom feed:', e);
      setCustomFeedError(extractErrorDetail(e, 'Couldn’t add that feed. Check the address and have another go.'));
    } finally {
      setAddingCustomFeed(false);
    }
  }, [customFeedUrl, addingCustomFeed, rememberOutlets]);

  const selectCountry = useCallback((code: string) => {
    setShowCountryPicker(false);
    setDetectedPlace(null);
    setCountryCode(code);
  }, []);

  // Any one of the three is enough - a quote on its own is a perfectly good morning card, and
  // news-on-with-nothing-picked-yet still saves a country the card can prompt from.

  const markOnboardingSeen = useCallback(async () => {
    if (!isOnboarding || !user) return;
    await AsyncStorage.setItem(`${DAILY_LIFT_SEEN_PREFIX}:${user.id}`, '1').catch(() => {});
  }, [isOnboarding, user]);

  const goToDestination = useCallback(() => {
    if (isOnboarding) router.replace('/(tabs)' as Href);
    else router.back();
  }, [isOnboarding, router]);

  /**
   * Persists the current selection. Called by the autosave effect below, and once more on the way
   * out of onboarding so a user who taps Continue immediately cannot outrun the debounce.
   *
   * Goes through AuthContext (not a bare dailyBrewApi call) so the in-memory user reflects what
   * was just saved - otherwise returning here would read the pre-save snapshot and show the
   * previous selection. News off means "no news at all", so the country goes with the outlets:
   * leaving a country behind keeps DailyBrewCard's hasNewsPrefs true and hides its setup row.
   */
  const persistPrefs = useCallback(async () => {
    try {
      await updateNewsPreferences(
        newsEnabled ? (countryCode || '') : '',
        newsEnabled ? selectedOutletIds : [],
        verseEnabled,
        quoteEnabled,
      );
    } catch (e) {
      // Silent by design. A toggle that flips back on a transient network error is more confusing
      // than one that quietly retries on the next change, and nothing here is destructive.
      console.error('Failed to save news preferences:', e);
    }
  }, [updateNewsPreferences, newsEnabled, countryCode, selectedOutletIds, verseEnabled, quoteEnabled]);

  // Autosave. A toggle is its own confirmation - asking someone to flip a switch and THEN press a
  // button is two actions for one decision, and it silently loses the change if they navigate
  // away. Debounced so tapping through several toggles is one write, not four.
  const didMountRef = useRef(false);
  useEffect(() => {
    // Skip the first run: mounting is not a change, and writing on mount would persist defaults
    // for a user who only opened the screen to look.
    if (!didMountRef.current) {
      didMountRef.current = true;
      return;
    }
    const t = setTimeout(() => { void persistPrefs(); }, 600);
    return () => clearTimeout(t);
  }, [persistPrefs]);

  // Flush on the way out. In settings the only exit is the back arrow, which unmounts the screen
  // and cancels the pending timer above - so a toggle flipped and immediately backed out of would
  // silently not save, which is the exact failure autosave is supposed to remove. Holds the latest
  // persist function in a ref so the unmount effect doesn't re-run on every change.
  const persistRef = useRef(persistPrefs);
  useEffect(() => { persistRef.current = persistPrefs; }, [persistPrefs]);
  useEffect(() => () => {
    if (didMountRef.current) void persistRef.current();
  }, []);

  const handleDone = useCallback(async () => {
    if (confirming) return;
    setConfirming(true);
    try {
      await markOnboardingSeen();
      // Flush ahead of the debounce - navigating away would otherwise cancel a pending write.
      await persistPrefs();
      if (isOnboarding) trackOnboardingStep('completed');
    } finally {
      setConfirming(false);
      goToDestination();
    }
  }, [confirming, markOnboardingSeen, persistPrefs, isOnboarding, goToDestination]);

  const handleSkip = useCallback(async () => {
    if (confirming) return;
    await markOnboardingSeen();
    trackOnboardingStep('skipped');
    router.replace('/(tabs)' as Href);
  }, [confirming, markOnboardingSeen, router]);

  return (
    <SafeAreaView style={s.container}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
      <View style={s.header}>
        {isOnboarding ? (
          <TouchableOpacity testID="news-settings-skip-btn" onPress={handleSkip} style={s.skipBtn}>
            <Text style={s.skipText}>Skip</Text>
          </TouchableOpacity>
        ) : (
          <TouchableOpacity onPress={() => router.back()} style={s.backBtn}>
            <MaterialIcons name="arrow-back" size={28} color={C.textSec} />
          </TouchableOpacity>
        )}
        <Text style={s.headerTitle}>Daily Brew</Text>
        <View style={{ width: 48 }} />
      </View>

      <ScrollView style={s.scroll} contentContainerStyle={s.scrollContent}>
        {isOnboarding && (
          <View style={s.intro}>
            <Text style={s.introTitle}>Something to open to each morning?</Text>
            <Text style={s.introSub}>Change it any time in settings.</Text>
          </View>
        )}

        <View style={[s.card, s.toggleCard]}>
          <View style={s.toggleRow}>
            <MaterialIcons name="menu-book" size={24} color={C.textSec} />
            <View style={{ flex: 1, marginLeft: 16 }}>
              <Text style={s.rowLabelPlain}>Verse of the day</Text>
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
            <View style={s.inlinePreview}>
              <Text style={s.inlinePreviewText} numberOfLines={2}>&ldquo;{todayVerse.text}&rdquo;</Text>
              <Text style={s.inlinePreviewAttr}>{todayVerse.reference}</Text>
            </View>
          )}
        </View>

        <View style={[s.card, s.toggleCard, { marginTop: 12 }]}>
          <View style={s.toggleRow}>
            <MaterialIcons name="format-quote" size={24} color={C.textSec} />
            <View style={{ flex: 1, marginLeft: 16 }}>
              <Text style={s.rowLabelPlain}>A daily quote</Text>
              <Text style={s.rowSub}>A short quote each day, alongside your news.</Text>
            </View>
            <Switch
              testID="quote-toggle"
              value={quoteEnabled}
              onValueChange={setQuoteEnabled}
              trackColor={{ false: C.borderSub, true: C.primary + '80' }}
              thumbColor={quoteEnabled ? C.primary : '#f4f3f4'}
            />
          </View>
          {quoteEnabled && (
            <View style={s.inlinePreview}>
              <Text style={s.inlinePreviewText} numberOfLines={2}>&ldquo;{todayQuote.text}&rdquo;</Text>
              <Text style={s.inlinePreviewAttr}>{todayQuote.author}</Text>
            </View>
          )}
        </View>

        <View style={[s.card, s.toggleCard, { marginTop: 12 }]}>
          <View style={s.toggleRow}>
            <MaterialIcons name="public" size={24} color={C.textSec} />
            <View style={{ flex: 1, marginLeft: 16 }}>
              <Text style={s.rowLabelPlain}>News from home</Text>
              <Text style={s.rowSub}>Headlines from the sources you follow.</Text>
            </View>
            <Switch
              testID="news-toggle"
              value={newsEnabled}
              onValueChange={setNewsEnabled}
              trackColor={{ false: C.borderSub, true: C.primary + '80' }}
              thumbColor={newsEnabled ? C.primary : '#f4f3f4'}
            />
          </View>
        </View>

        {/* Everything below belongs to the News toggle and is mounted only while it's on. The
            selections themselves are kept in state either way, so flicking news off and back on
            doesn't discard what was picked - only the confirm payload treats "off" as none. */}
        {newsEnabled && (
          <>
            {/* Always-visible summary of every current selection, regardless of country/search state -
                a topic followed via search would otherwise disappear from view the moment the search
                query changes, with no other way to see (or unfollow) it. */}
            {selectedOutletIds.length > 0 && (
              <View style={[s.card, { marginTop: 12 }]}>
                <Text style={s.sectionLabel}>Following <Text style={s.sectionLabelHint}>(maximum {MAX_OUTLETS})</Text></Text>
                {selectedOutletIds.map((id) => {
                  const outlet = outletDetails[id];
                  const avatarColor = TAG_COLORS[hashIndex(id) % TAG_COLORS.length].value;
                  return (
                    <View key={id} testID={`news-following-${id}`} style={s.row}>
                      <View style={[s.outletAvatar, { backgroundColor: avatarColor }]}>
                        <Text style={s.outletAvatarLetter}>{(outlet?.name ?? '?').charAt(0).toUpperCase()}</Text>
                      </View>
                      <View style={{ flex: 1, marginLeft: 12 }}>
                        <Text style={s.rowLabelPlain}>{outlet?.name ?? id}</Text>
                        {!!outlet?.description && (
                          <Text style={s.rowSub} numberOfLines={1}>{outlet.description}</Text>
                        )}
                      </View>
                      <TouchableOpacity
                        testID={`news-unfollow-${id}`}
                        onPress={() => toggleOutlet(id)}
                        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                      >
                        <MaterialIcons name="close" size={22} color={C.borderSub} />
                      </TouchableOpacity>
                    </View>
                  );
                })}
              </View>
            )}

            <View style={[s.card, { marginTop: 12 }]}>
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
                    Couldn&apos;t find your location. Tap Change to pick it yourself.
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

            <View style={[s.card, { marginTop: 12 }]}>
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

            <View style={[s.card, { marginTop: 12 }]}>
              <Text style={s.sectionLabel}>Add your own feed</Text>
              <Text style={[s.rowSub, { marginBottom: 12 }]}>
                Have a favorite site with an RSS or Atom feed? Paste its link here.
              </Text>
              <View style={s.searchBox}>
                <MaterialIcons name="rss-feed" size={20} color={C.borderSub} />
                <TextInput
                  testID="news-custom-feed-input"
                  style={s.searchInput}
                  placeholder="https://example.com/feed"
                  placeholderTextColor={C.borderSub}
                  value={customFeedUrl}
                  onChangeText={(t) => { setCustomFeedUrl(t); setCustomFeedError(''); }}
                  autoCapitalize="none"
                  autoCorrect={false}
                  keyboardType="url"
                  onSubmitEditing={handleAddCustomFeed}
                />
                {addingCustomFeed && <ActivityIndicator size="small" color={C.primary} />}
              </View>
              <TouchableOpacity
                testID="news-custom-feed-add-btn"
                style={[s.confirmBtn, { marginTop: 4 }, (!customFeedUrl.trim() || addingCustomFeed) && s.confirmBtnDisabled]}
                onPress={handleAddCustomFeed}
                disabled={!customFeedUrl.trim() || addingCustomFeed}
              >
                <Text style={s.confirmBtnText}>Add feed</Text>
              </TouchableOpacity>
              {!!customFeedError && (
                <Text style={[s.rowSub, { color: C.danger, marginTop: 8 }]}>{customFeedError}</Text>
              )}
            </View>
          </>
        )}

        {/* Onboarding only. Settings has nothing to confirm - every change is already saved, so a
            Confirm button there would imply changes were pending when they were not. Here it is
            purely "I'm finished with this step", not "save my choices". */}
        {isOnboarding && (
          <TouchableOpacity
            testID="news-settings-confirm-btn"
            style={[s.confirmBtn, confirming && s.confirmBtnDisabled]}
            onPress={handleDone}
            disabled={confirming}
          >
            {confirming
              ? <ActivityIndicator size="small" color={C.primaryFg} />
              : <Text style={s.confirmBtnText}>Continue</Text>}
          </TouchableOpacity>
        )}

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
  intro: { marginBottom: 20 },
  introTitle: { fontSize: 25, fontWeight: '700', color: C.text, lineHeight: 32 },
  introSub: { fontSize: 14, color: C.textSec, marginTop: 8 },
  card: {
    backgroundColor: C.surface, padding: 20, borderRadius: radius.md,
    // No border, matching the note/event/Daily Brew cards. Surface (#FFFFFF) and page (#FDFBF7)
    // are close enough that a borderless card would nearly dissolve into the background, so a
    // very soft green-tinted shadow keeps the edge readable without a visible grey line.
    shadowColor: '#0A5443', shadowOpacity: 0.06, shadowRadius: 6, shadowOffset: { width: 0, height: 2 },
    elevation: 1,
  },
  toggleCard: { paddingVertical: 24, paddingHorizontal: 24 },
  sectionLabel: { fontSize: 16, fontWeight: '600', color: C.textSec, marginBottom: 12 },
  sectionLabelHint: { fontSize: 13, fontWeight: '400', color: C.borderSub },
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
  // Today's real content for whichever toggle it sits under - a divider inside the card, not a
  // card of its own, so the preview reads as belonging to the row that revealed it.
  inlinePreview: { marginTop: 16, paddingTop: 16, borderTopWidth: 1, borderTopColor: C.borderSub + '30' },
  inlinePreviewText: { fontSize: 15, color: C.text, fontStyle: 'italic', lineHeight: 22 },
  inlinePreviewAttr: { fontSize: 13, color: C.primary, marginTop: 6, fontWeight: '600' },
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
