/**
 * DailyBrewCard.tsx
 * Self-contained "Daily Brew" card shown at the top of My Notes: date, weather, today's events,
 * an opt-in Bible verse, up to 3 news headlines, and a "Done for today" dismiss. Own local
 * StyleSheet + Animated, same shape as OfflineBanner.tsx.
 *
 * Feature-flag gated (daily-brew-enabled, see src/analytics/posthog.ts): renders null and skips
 * all fetch logic if the flag isn't on, so a user who onboarded while it was on stops seeing the
 * card cleanly once it's flipped off.
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
import { useRouter, useFocusEffect, type Href } from 'expo-router';
import { C, radius, borderWidth, DAY_NAMES, MONTH_NAMES } from '../theme';
import { useAuth } from '../auth';
import { isDailyBrewEnabled } from '../analytics';
import { getVerseForDate } from '../dailyBrew/verses';
import {
  isDismissedToday, markDismissedToday, isPersistPinned, getCachedBrew, setCachedBrew, pruneOldKeys,
  fetchEventsToday, fetchWeather, fetchNewsHeadlines, BrewEvent, NewsItem,
} from '../dailyBrew/dailyBrew';

// Old Android bridge needs this opt-in for LayoutAnimation; no-op on iOS/New Architecture.
if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

const NEWS_SHOWN = 3;

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
      let cancelled = false;

      (async () => {
        const flagOn = await isDailyBrewEnabled();
        if (cancelled) return;
        setFlagEnabled(flagOn);
        if (!flagOn) return; // Flag off - skip fetch logic entirely, card renders null below.

        const persistPinned = await isPersistPinned();
        if (cancelled) return;
        setPinned(persistPinned);

        // Pinned mode ignores the daily dismiss entirely - always shown while the flag's on.
        const alreadyDismissed = persistPinned ? false : await isDismissedToday();
        if (cancelled) return;
        if (alreadyDismissed) {
          setDismissed(true);
          return;
        }
        setDismissed(false);
        playEntrance();

        // Stale-while-revalidate: hydrate instantly from cache before the fresh fetch resolves.
        const cached = await getCachedBrew();
        if (cancelled) return;
        setEvents(cached?.events !== undefined ? cached.events : 'loading');
        setWeather(cached?.weather != null ? cached.weather : 'loading');
        setNews(cached?.news !== undefined ? cached.news : 'loading');

        pruneOldKeys();

        const [eventsR, weatherR, newsR] = await Promise.allSettled([
          fetchEventsToday(),
          fetchWeather(),
          fetchNewsHeadlines(),
        ]);
        if (cancelled) return;

        if (eventsR.status === 'fulfilled') {
          setEvents(eventsR.value);
          setCachedBrew({ events: eventsR.value });
        } else {
          setEvents([]);
        }

        if (weatherR.status === 'fulfilled') {
          setWeather(weatherR.value);
          // Only cache real readings - 'denied'/'error' aren't part of CachedBrew's shape and
          // shouldn't paper over a fresh permission grant on the next load.
          if (weatherR.value !== 'denied' && weatherR.value !== 'error') {
            setCachedBrew({ weather: weatherR.value });
          }
        } else {
          setWeather('error');
        }

        if (newsR.status === 'fulfilled') {
          setNews(newsR.value);
          setCachedBrew({ news: newsR.value });
        } else {
          setNews([]);
        }
      })();

      return () => { cancelled = true; };
    }, [])
  );

  const verse = useMemo(() => getVerseForDate(new Date()), []);
  const showVerse = user?.daily_brew_show_verse === true;
  const hasNewsPrefs = Boolean(user?.news_country) || Boolean(user?.news_outlet_ids?.length);

  const handleDone = async () => {
    await markDismissedToday();
    Animated.parallel([
      Animated.timing(cardOpacity, { toValue: 0, duration: 200, useNativeDriver: true }),
      Animated.spring(cardScale, { toValue: 0.85, useNativeDriver: true, friction: 8 }),
    ]).start(() => {
      // The card's own fade/shrink is done - now animate the layout reflow as it leaves,
      // so the notes list below eases back up into the vacated space instead of snapping.
      LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
      setDismissed(true);
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
      ) : null}

      {events !== 'loading' && (
        eventsList.length > 0 ? (
          eventsList.map((e) => (
            <TouchableOpacity
              key={e.id}
              style={s.row}
              onPress={() => router.push({ pathname: '/event-editor', params: { eventId: e.id } })}
            >
              <MaterialIcons name="event" size={17} color={C.textSec} />
              <Text style={s.rowText} numberOfLines={1}>
                {e.title} · {formatEventTime(e.startTime)}
              </Text>
            </TouchableOpacity>
          ))
        ) : (
          <View style={s.row}>
            <MaterialIcons name="newspaper" size={17} color={C.textSec} />
            <Text style={s.rowTextMuted}>No events today</Text>
          </View>
        )
      )}

      {showVerse && (
        <TouchableOpacity style={s.row} onPress={() => router.push('/daily-verse' as Href)}>
          <MaterialIcons name="menu-book" size={17} color={C.textSec} />
          <Text style={s.rowText} numberOfLines={2} ellipsizeMode="tail">
            {verse.text} — {verse.reference}
          </Text>
        </TouchableOpacity>
      )}

      {news !== 'loading' && (
        newsList.length > 0 ? (
          newsList.map((item, i) => (
            <TouchableOpacity key={`${item.link}-${i}`} style={s.row} onPress={() => Linking.openURL(item.link)}>
              {item.logoUrl ? (
                <Image source={{ uri: item.logoUrl }} style={s.newsLogo} />
              ) : (
                <MaterialIcons name="newspaper" size={17} color={C.textSec} />
              )}
              <View style={s.rowTextCol}>
                <Text style={s.rowMeta}>
                  {item.sourceName}{formatRelativeTime(item.publishedAt) ? ` · ${formatRelativeTime(item.publishedAt)}` : ''}
                </Text>
                <Text style={s.rowText} numberOfLines={1}>{item.headline}</Text>
              </View>
            </TouchableOpacity>
          ))
        ) : hasNewsPrefs ? (
          <View style={s.row}>
            <MaterialIcons name="newspaper" size={17} color={C.textSec} />
            <Text style={s.rowTextMuted}>Headline unavailable right now</Text>
          </View>
        ) : (
          <TouchableOpacity style={s.row} onPress={() => router.push('/news-source-settings' as Href)}>
            <MaterialIcons name="newspaper" size={17} color={C.textSec} />
            <Text style={s.rowText}>Set up News from home</Text>
          </TouchableOpacity>
        )
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
    backgroundColor: C.surface, borderRadius: radius.md, padding: 12,
    borderWidth: borderWidth.regular, borderColor: C.border, marginBottom: 10,
  },
  dateHeading: { fontSize: 18, fontWeight: '600', color: C.text, marginBottom: 8 },
  weatherChip: {
    alignSelf: 'flex-start', borderRadius: radius.pill, backgroundColor: C.surfaceHi,
    paddingHorizontal: 10, paddingVertical: 4, flexDirection: 'row', alignItems: 'center',
    gap: 6, marginBottom: 8,
  },
  weatherText: { fontSize: 13, fontWeight: '500', color: C.text },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 6 },
  newsLogo: { width: 17, height: 17, borderRadius: 4 },
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
