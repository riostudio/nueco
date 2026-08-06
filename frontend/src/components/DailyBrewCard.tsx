/**
 * DailyBrewCard.tsx
 * Self-contained "Daily Brew" card shown at the top of My Notes: date, weather, today's events,
 * an opt-in Bible verse, up to 3 news headlines, and a "Done for today" dismiss. Own local
 * StyleSheet + Animated, same shape as OfflineBanner.tsx.
 *
 * Feature-flag gated (daily-brew-enabled, resolved server-side - see backend/featureflags.py and
 * user.daily_brew_enabled): renders null and skips all fetch logic if the flag isn't on, so a
 * user who onboarded while it was on stops seeing the card cleanly once it's flipped off.
 *
 * Loading is silent, not spinner-driven: each section (weather/events/news) is simply omitted
 * from layout until it resolves (from cache instantly, or from the background fetch a moment
 * later) rather than showing a spinner in its place - this card is read once at a glance, not a
 * form someone's waiting on, so a placeholder that visibly "loads" is more distracting than useful.
 *
 * `preview`: onboarding shows this card before the user has granted location or picked news
 * sources, so it can't fetch anything real yet - static sample content instead, to demonstrate
 * the concept rather than an empty/half-loaded real card. Same entrance animation either way.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, Image, StyleSheet, TouchableOpacity, Animated, Linking, LayoutAnimation, Platform, UIManager,
} from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { prefixEmoji } from '../events/eventEmoji';
import { SkeletonBlock, BrewRowSkeleton } from './Skeleton';
import { useRouter, useFocusEffect, type Href } from 'expo-router';
import { C, radius, borderWidth } from '../theme';
import { DAY_NAMES, MONTH_NAMES } from '../dateNames';
import { useAuth } from '../auth';
import { getVerseForDate } from '../dailyBrew/verses';
import { getQuoteForDate } from '../dailyBrew/quotes';
import {
  isDismissedToday, markDismissedToday, isPersistPinned, getCachedBrew, setCachedBrew, pruneOldKeys,
  fetchEventsToday, fetchWeather, fetchNewsHeadlines, BrewEvent, NewsItem, CachedBrew,
} from '../dailyBrew/dailyBrew';

// Old Android bridge needs this opt-in for LayoutAnimation; no-op on iOS/New Architecture.
if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

const NEWS_SHOWN = 3;
// How long a cached brew is trusted as final before re-fetching on the next focus. Bounds how
// often this card's weather/events/news call re-fires just from switching tabs or navigating back.
const REVALIDATE_INTERVAL_MS = 5 * 60 * 1000;

const PREVIEW_WEATHER: { tempC: number; condition: string; icon: string; color: string; place: string } = {
  tempC: 22, condition: 'Sunny', icon: 'wb-sunny', color: '#F2B23C', place: 'San Francisco',
};
const PREVIEW_EVENTS: BrewEvent[] = [
  { id: '', title: 'Team standup', startTime: new Date(new Date().setHours(9, 0, 0, 0)).toISOString() },
];
const PREVIEW_NEWS: NewsItem[] = [
  { headline: 'News from your chosen sources shows up here', link: '', sourceName: 'Example News', publishedAt: null, logoUrl: null },
];

type IconName = React.ComponentProps<typeof MaterialIcons>['name'];
type EventsState = BrewEvent[] | 'loading';
type WeatherState = Awaited<ReturnType<typeof fetchWeather>> | 'loading';
type NewsState = NewsItem[] | 'loading';

// Duplicated from calendar.tsx (not exported there) rather than importing across screens.
function formatEventTime(iso: string): string {
  const d = new Date(iso);
  const h = d.getHours();
  const m = d.getMinutes();
  const ampm = h >= 12 ? 'PM' : 'AM';
  const hour = h % 12 || 12;
  return `${hour}:${m.toString().padStart(2, '0')} ${ampm}`;
}

// Same relative-time logic as index.tsx's note-card formatter (also local/unexported there).
function formatRelativeTime(dateStr: string | null): string {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  const now = new Date();
  const diff = now.getTime() - d.getTime();
  const mins = Math.floor(diff / 60000);
  if (Number.isNaN(mins)) return '';
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days} days ago`;
  return d.toLocaleDateString();
}

type Props = { preview?: boolean };

export default function DailyBrewCard({ preview = false }: Props) {
  const router = useRouter();
  const { user } = useAuth();
  const [flagEnabled, setFlagEnabled] = useState<boolean | null>(preview ? true : null);
  const [dismissed, setDismissed] = useState<boolean | null>(preview ? false : null);
  const [pinned, setPinned] = useState(false);
  const [events, setEvents] = useState<EventsState>(preview ? PREVIEW_EVENTS : 'loading');
  const [weather, setWeather] = useState<WeatherState>(preview ? PREVIEW_WEATHER : 'loading');
  const [news, setNews] = useState<NewsState>(preview ? PREVIEW_NEWS : 'loading');

  const cardOpacity = useRef(new Animated.Value(preview ? 0 : 1)).current;
  const cardScale = useRef(new Animated.Value(preview ? 0.96 : 1)).current;
  const cardTranslateY = useRef(new Animated.Value(preview ? 12 : 0)).current;
  // Guards the entrance animation to the card's first real appearance per mount, rather than
  // replaying every time useFocusEffect re-fires (e.g. switching tabs back and forth).
  const hasAnimatedIn = useRef(false);

  const playEntrance = useCallback(() => {
    if (hasAnimatedIn.current) return;
    hasAnimatedIn.current = true;
    Animated.parallel([
      Animated.timing(cardOpacity, { toValue: 1, duration: 280, useNativeDriver: true }),
      Animated.spring(cardTranslateY, { toValue: 0, useNativeDriver: true, friction: 8 }),
      Animated.spring(cardScale, { toValue: 1, useNativeDriver: true, friction: 8 }),
    ]).start();
  }, [cardOpacity, cardScale, cardTranslateY]);

  // Preview mode has nothing to wait on - play the reveal as soon as it mounts.
  useEffect(() => { if (preview) playEntrance(); }, [preview, playEntrance]);

  useFocusEffect(
    useCallback(() => {
      if (preview) return;
      if (!user) return;
      const userId = user.id;
      let cancelled = false;

      (async () => {
        const flagOn = user.daily_brew_enabled === true;
        setFlagEnabled(flagOn);
        if (!flagOn) return; // Flag off - skip fetch logic entirely, card renders null below.

        // Started immediately, in parallel with the pinned/dismissed checks below (which don't
        // depend on it) - every AsyncStorage round-trip on the way to showing cached content
        // adds to how long the card takes to appear "straight away".
        const cachedPromise = getCachedBrew(userId);

        const persistPinned = await isPersistPinned(userId);
        if (cancelled) return;
        setPinned(persistPinned);

        // Pinned mode ignores the daily dismiss entirely - always shown while the flag's on.
        const alreadyDismissed = persistPinned ? false : await isDismissedToday(userId);
        if (cancelled) return;
        if (alreadyDismissed) {
          setDismissed(true);
          return;
        }
        setDismissed(false);
        playEntrance();

        // Stale-while-revalidate: hydrate instantly from cache before the fresh fetch resolves.
        const cached = await cachedPromise;
        if (cancelled) return;
        setEvents(cached?.events !== undefined ? cached.events : 'loading');
        setWeather(cached?.weather != null ? cached.weather : 'loading');
        setNews(cached?.news !== undefined ? cached.news : 'loading');

        pruneOldKeys();

        // A cache recent enough is shown as final, not "loading-then-replaced" - this card
        // re-runs its whole fetch on every focus (switching tabs, coming back from the editor),
        // so without this a fresh network round-trip re-fires every single time, producing a
        // visible pop-in even when nothing could plausibly have changed in the last few minutes.
        const isFreshEnough = cached != null && Date.now() - cached.fetchedAt < REVALIDATE_INTERVAL_MS;
        if (isFreshEnough) return;

        const [eventsR, weatherR, newsR] = await Promise.allSettled([
          fetchEventsToday(),
          fetchWeather(),
          fetchNewsHeadlines(),
        ]);
        if (cancelled) return;

        // Built up and written as ONE setCachedBrew call below - three separate calls here used
        // to each independently read-modify-write the same AsyncStorage key with no ordering
        // guarantee between them, so whichever of the three finished last would win and silently
        // drop whatever the other two had just written. That corruption was invisible before
        // (the card always re-fetched live on every focus, ignoring the cache), but the
        // isFreshEnough check above now trusts the cache directly - so a dropped field showed up
        // as "loading" forever on any focus that skipped the live fetch.
        const cacheUpdate: Partial<CachedBrew> = {};

        if (eventsR.status === 'fulfilled') {
          setEvents(eventsR.value);
          cacheUpdate.events = eventsR.value;
        } else {
          setEvents([]);
        }

        if (weatherR.status === 'fulfilled') {
          setWeather(weatherR.value);
          // Only cache real readings - 'denied'/'error' aren't part of CachedBrew's shape and
          // shouldn't paper over a fresh permission grant on the next load.
          if (weatherR.value !== 'denied' && weatherR.value !== 'error') {
            cacheUpdate.weather = weatherR.value;
          }
        } else {
          setWeather('error');
        }

        if (newsR.status === 'fulfilled') {
          setNews(newsR.value);
          cacheUpdate.news = newsR.value;
        } else {
          setNews([]);
        }

        if (Object.keys(cacheUpdate).length > 0) setCachedBrew(userId, cacheUpdate);
      })();

      return () => { cancelled = true; };
    }, [user])
  );

  const verse = useMemo(() => getVerseForDate(new Date()), []);
  const showVerse = user?.daily_brew_show_verse === true;
  const quote = useMemo(() => getQuoteForDate(new Date()), []);
  const showQuote = user?.daily_brew_show_quote === true;
  const hasNewsPrefs = Boolean(user?.news_country) || Boolean(user?.news_outlet_ids?.length);

  const handleDone = async () => {
    if (!user) return;
    await markDismissedToday(user.id);
    Animated.parallel([
      Animated.timing(cardOpacity, { toValue: 0, duration: 200, useNativeDriver: true }),
      Animated.spring(cardScale, { toValue: 0.85, useNativeDriver: true, friction: 8 }),
    ]).start(() => {
      // The card's own fade/shrink is done - now animate the layout reflow as it leaves,
      // so the notes list below eases back up into the vacated space instead of snapping.
      LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
      setDismissed(true);
      // Without this, hasAnimatedIn stays permanently true from the card's first-ever entrance,
      // so the next time it's asked to reappear (e.g. toggling "Keep Daily Brew pinned" back on
      // forces alreadyDismissed to false) playEntrance() no-ops and the card renders stuck at
      // this dismiss animation's end state - opacity 0, scale 0.85 - invisible but still taking
      // up its normal layout height.
      hasAnimatedIn.current = false;
    });
  };

  if (!flagEnabled || dismissed === null || dismissed === true) return null;

  const now = new Date();
  const dateHeading = `${DAY_NAMES[now.getDay()]}, ${MONTH_NAMES[now.getMonth()]} ${now.getDate()}, ${now.getFullYear()}`;
  const newsList = news === 'loading' ? [] : news.slice(0, NEWS_SHOWN);
  const eventsList = events === 'loading' ? [] : events;

  return (
    <Animated.View
      style={[
        s.card,
        { opacity: cardOpacity, transform: [{ translateY: cardTranslateY }, { scale: cardScale }] },
      ]}
    >
      <Text style={s.dateHeading}>{dateHeading}</Text>

      {weather === 'denied' || weather === 'error' ? (
        <View style={s.weatherChip}>
          <MaterialIcons name="location-on" size={16} color={C.borderSub} />
          <Text style={[s.weatherText, { color: C.borderSub }]}>Weather unavailable</Text>
        </View>
      ) : weather !== 'loading' ? (
        <View style={s.weatherChip}>
          <MaterialIcons name={weather.icon as IconName} size={16} color={weather.color} />
          <Text style={s.weatherText}>
            {weather.place ? `${weather.place} · ` : ''}{Math.round(weather.tempC)}° {weather.condition}
          </Text>
        </View>
      ) : (
        // Placeholder keeps the chip's line present, so the rows below don't jump down
        // when the weather lands.
        <View style={{ marginBottom: 8 }}><SkeletonBlock width={140} height={26} radius={999} /></View>
      )}

      {events !== 'loading' ? (
        eventsList.length > 0 ? (
          eventsList.map((e) => (
            <TouchableOpacity
              key={e.id}
              style={s.eventRow}
              onPress={() => router.push(`/event?eventId=${e.id}` as Href)}
            >
              <View style={s.slot}><MaterialIcons name="event-note" size={20} color={C.secondary} /></View>
              <Text style={s.eventRowText} numberOfLines={1}>
                {prefixEmoji(e.title)} · {formatEventTime(e.startTime)}
              </Text>
            </TouchableOpacity>
          ))
        ) : (
          <View style={s.row}>
            <View style={s.slot}><MaterialIcons name="newspaper" size={20} color={C.textSec} /></View>
            <Text style={s.rowTextMuted}>No events today</Text>
          </View>
        )
      ) : (
        <BrewRowSkeleton />
      )}

      {showVerse && (
        <TouchableOpacity style={s.row} onPress={() => router.push('/daily-verse' as Href)}>
          <View style={s.slot}><MaterialIcons name="menu-book" size={20} color={C.textSec} /></View>
          <Text style={s.rowText} numberOfLines={2} ellipsizeMode="tail">
            {verse.text} — {verse.reference}
          </Text>
        </TouchableOpacity>
      )}

      {showQuote && (
        <View style={s.row}>
          <View style={s.slot}><MaterialIcons name="format-quote" size={20} color={C.textSec} /></View>
          <Text style={s.rowText} numberOfLines={2} ellipsizeMode="tail">
            {quote.text} — {quote.author}
          </Text>
        </View>
      )}

      {news !== 'loading' ? (
        newsList.length > 0 ? (
          newsList.map((item, i) => (
            <TouchableOpacity key={`${item.link}-${i}`} style={s.newsRow} onPress={() => Linking.openURL(item.link)}>
              {/* Circular brand avatar, WhatsApp-Channels style. Logos were dropped earlier at
                  17px, where outlet artwork was unreadable and every outlet's different
                  proportions left the column ragged. At 44px circular they do the opposite: mastheads
                  are recognisable at a glance and the circle crops every source to the same shape,
                  so the left rail stays even no matter what artwork comes back from the feed. */}
              {item.logoUrl ? (
                <Image source={{ uri: item.logoUrl }} style={s.newsAvatar} />
              ) : (
                // Monogram fallback rather than a generic newspaper glyph: it keeps the rail
                // aligned and still distinguishes one source from another.
                <View style={[s.newsAvatar, s.newsAvatarFallback]}>
                  <Text style={s.newsAvatarLetter}>
                    {(item.sourceName || '?').trim().charAt(0).toUpperCase()}
                  </Text>
                </View>
              )}
              <View style={s.newsTextCol}>
              {/* Headline first, at full weight. The source and time used to sit ABOVE it in grey,
                  so the eye landed on "ABC News · 2h ago" before the thing worth reading. Two
                  lines rather than one: a headline cut mid-sentence gives no basis for deciding
                  whether to tap, which is the only decision this row exists to support. */}
              <Text style={s.newsHeadline} numberOfLines={2}>{item.headline}</Text>
              <Text style={s.newsMeta} numberOfLines={1}>
                {item.sourceName}{formatRelativeTime(item.publishedAt) ? ` · ${formatRelativeTime(item.publishedAt)}` : ''}
              </Text>
              </View>
            </TouchableOpacity>
          ))
        ) : hasNewsPrefs ? (
          <View style={s.row}>
            <View style={s.slot}><MaterialIcons name="newspaper" size={20} color={C.textSec} /></View>
            <Text style={s.rowTextMuted}>Headline unavailable right now</Text>
          </View>
        ) : (
          // `news=1` opens the setup screen with its News section already expanded. That screen
          // otherwise defaults the toggle from what's saved, so someone with only the verse
          // switched on would tap a row saying "set up news" and land on news switched off.
          <TouchableOpacity style={s.row} onPress={() => router.push('/news-source-settings?news=1' as Href)}>
            <View style={s.slot}><MaterialIcons name="newspaper" size={20} color={C.textSec} /></View>
            <Text style={s.rowText}>Set up News from home</Text>
          </TouchableOpacity>
        )
      ) : (
        <>
          <BrewRowSkeleton lines={2} circle />
          <BrewRowSkeleton lines={2} circle />
        </>
      )}

      {!preview && !pinned && (
        <TouchableOpacity style={s.doneBtn} onPress={handleDone} activeOpacity={0.7}>
          <MaterialIcons name="done" size={16} color={C.primary} />
          <Text style={s.doneText}>Done for today</Text>
        </TouchableOpacity>
      )}
    </Animated.View>
  );
}

const s = StyleSheet.create({
  card: {
    backgroundColor: C.surface, borderRadius: radius.md, padding: 12, marginBottom: 10,
    // Border removed by request. Surface (#FFFFFF) and page (#FDFBF7) are close enough that a
    // borderless card would nearly dissolve into the background, so a very soft shadow keeps the
    // edge readable without reintroducing a visible grey line.
    shadowColor: '#0A5443', shadowOpacity: 0.06, shadowRadius: 6, shadowOffset: { width: 0, height: 2 },
    elevation: 1,
  },
  dateHeading: { fontSize: 18, fontWeight: '600', color: C.text, marginBottom: 8 },
  weatherChip: {
    alignSelf: 'flex-start', borderRadius: radius.pill, backgroundColor: C.surfaceHi,
    paddingHorizontal: 10, paddingVertical: 4, flexDirection: 'row', alignItems: 'center',
    gap: 6, marginBottom: 8,
  },
  weatherText: { fontSize: 13, fontWeight: '500', color: C.text },
  // paddingHorizontal matches eventRow's padding: the event chip is a filled block, so its own
  // 8px inset pushes its icon in by 8 while a plain row's icon starts at the card edge. Insetting
  // every row by the same 8 is what puts all four text left-edges on one line.
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 6, paddingHorizontal: 8 },
  // Same light-blue treatment as a note's linked-event chip (see (tabs)/index.tsx's
  // eventInfo/eventInfoTitle) - same visual language for "this is a calendar event" everywhere.
  eventRow: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    backgroundColor: C.secondaryTint, borderRadius: 8, padding: 8, marginBottom: 6,
  },
  eventRowText: { flex: 1, fontSize: 14, fontWeight: '600', color: C.secondary },
  newsRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 8, paddingHorizontal: 8 },
  newsTextCol: { flex: 1, gap: 3 },
  // Fixed-width icon column. Every row's text starts at the same x because the slot is a constant
  // 32 regardless of the glyph inside it - matching the news logos, which are content and earn
  // that size. The glyphs are labels, so they sit smaller inside the same footprint.
  slot: { width: 32, alignItems: 'center', justifyContent: 'center' },
  newsAvatar: { width: 32, height: 32, borderRadius: 16 },
  newsAvatarFallback: { backgroundColor: C.secondaryTint, alignItems: 'center', justifyContent: 'center' },
  newsAvatarLetter: { fontSize: 18, fontWeight: '700', color: C.primary },
  newsHeadline: { fontSize: 14, lineHeight: 19, color: C.text, fontWeight: '500' },
  newsMeta: { fontSize: 12, color: C.textSec },
  rowText: { flex: 1, fontSize: 14, color: C.text },
  rowTextMuted: { flex: 1, fontSize: 14, color: C.textSec },
  rowTextCol: { flex: 1 },
  rowMeta: { fontSize: 12, color: C.textSec, marginBottom: 2 },
  doneBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 6, paddingVertical: 4,
    alignSelf: 'flex-start',
  },
  doneText: { fontSize: 14, fontWeight: '600', color: C.primary },
});
