/**
 * DailyBrewCard.tsx
 * Self-contained "Daily Brew" card shown at the top of My Notes: date, weather, today's next
 * event (or a second headline if there's none), an opt-in Bible verse, a news headline, and a
 * "Done for today" dismiss. Own local StyleSheet + Animated, same shape as OfflineBanner.tsx.
 *
 * Feature-flag gated (daily-brew-enabled, see src/analytics/posthog.ts): renders null and skips
 * all fetch logic if the flag isn't on, so a user who onboarded while it was on stops seeing the
 * card cleanly once it's flipped off.
 */
import React, { useCallback, useMemo, useRef, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator, Animated, Linking } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { useRouter, useFocusEffect, type Href } from 'expo-router';
import { C, radius, borderWidth } from '../theme';
import { useAuth } from '../auth';
import { isDailyBrewEnabled } from '../analytics';
import { getVerseForDate } from '../dailyBrew/verses';
import {
  isDismissedToday, markDismissedToday, getCachedBrew, setCachedBrew, pruneOldKeys,
  fetchNextEventToday, fetchWeather, fetchNewsHeadlines, NewsItem,
} from '../dailyBrew/dailyBrew';

type IconName = React.ComponentProps<typeof MaterialIcons>['name'];
type EventState = Awaited<ReturnType<typeof fetchNextEventToday>> | 'loading';
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

export default function DailyBrewCard() {
  const router = useRouter();
  const { user } = useAuth();
  const [flagEnabled, setFlagEnabled] = useState<boolean | null>(null);
  const [dismissed, setDismissed] = useState<boolean | null>(null);
  const [event, setEvent] = useState<EventState>('loading');
  const [weather, setWeather] = useState<WeatherState>('loading');
  const [news, setNews] = useState<NewsState>('loading');

  const cardOpacity = useRef(new Animated.Value(1)).current;
  const cardScale = useRef(new Animated.Value(1)).current;

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;

      (async () => {
        const flagOn = await isDailyBrewEnabled();
        if (cancelled) return;
        setFlagEnabled(flagOn);
        if (!flagOn) return; // Flag off - skip fetch logic entirely, card renders null below.

        const alreadyDismissed = await isDismissedToday();
        if (cancelled) return;
        if (alreadyDismissed) {
          setDismissed(true);
          return;
        }
        setDismissed(false);

        // Stale-while-revalidate: hydrate instantly from cache before the fresh fetch resolves.
        const cached = await getCachedBrew();
        if (cancelled) return;
        setEvent(cached?.event !== undefined ? cached.event : 'loading');
        setWeather(cached?.weather != null ? cached.weather : 'loading');
        setNews(cached?.news !== undefined ? cached.news : 'loading');

        pruneOldKeys();

        const [eventR, weatherR, newsR] = await Promise.allSettled([
          fetchNextEventToday(),
          fetchWeather(),
          fetchNewsHeadlines(),
        ]);
        if (cancelled) return;

        if (eventR.status === 'fulfilled') {
          setEvent(eventR.value);
          setCachedBrew({ event: eventR.value });
        } else {
          setEvent(null);
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
    ]).start(() => setDismissed(true));
  };

  if (!flagEnabled || dismissed === null || dismissed === true) return null;

  const dateHeading = new Date().toLocaleDateString(undefined, {
    weekday: 'long', month: 'long', day: 'numeric',
  });
  const newsList = news === 'loading' ? [] : news;

  return (
    <Animated.View style={[s.card, { opacity: cardOpacity, transform: [{ scale: cardScale }] }]}>
      <Text style={s.dateHeading}>{dateHeading}</Text>

      {weather === 'loading' ? (
        <View style={s.weatherChip}>
          <ActivityIndicator size="small" color={C.textSec} />
        </View>
      ) : weather === 'denied' || weather === 'error' ? (
        <View style={s.weatherChip}>
          <MaterialIcons name="location-on" size={16} color={C.borderSub} />
          <Text style={[s.weatherText, { color: C.borderSub }]}>Weather unavailable</Text>
        </View>
      ) : (
        <View style={s.weatherChip}>
          <MaterialIcons name={weather.icon as IconName} size={16} color={weather.color} />
          <Text style={s.weatherText}>
            {weather.place ? `${weather.place} · ` : ''}{Math.round(weather.tempC)}° {weather.condition}
          </Text>
        </View>
      )}

      {event === 'loading' ? (
        <View style={s.row}>
          <MaterialIcons name="event" size={17} color={C.textSec} />
          <ActivityIndicator size="small" color={C.textSec} style={s.rowSpinner} />
        </View>
      ) : event ? (
        <TouchableOpacity
          style={s.row}
          onPress={() => router.push({ pathname: '/event-editor', params: { eventId: event.id } })}
        >
          <MaterialIcons name="event" size={17} color={C.textSec} />
          <Text style={s.rowText} numberOfLines={1}>
            {event.title} · {formatEventTime(event.startTime)}
          </Text>
        </TouchableOpacity>
      ) : newsList.length >= 2 ? (
        <TouchableOpacity style={s.row} onPress={() => Linking.openURL(newsList[1].link)}>
          <MaterialIcons name="event" size={17} color={C.textSec} />
          <View style={s.rowTextCol}>
            <Text style={s.rowMeta}>
              {newsList[1].sourceName}{formatRelativeTime(newsList[1].publishedAt) ? ` · ${formatRelativeTime(newsList[1].publishedAt)}` : ''}
            </Text>
            <Text style={s.rowText} numberOfLines={1}>{newsList[1].headline}</Text>
          </View>
        </TouchableOpacity>
      ) : (
        <View style={s.row}>
          <MaterialIcons name="event" size={17} color={C.textSec} />
          <Text style={s.rowTextMuted}>No events today</Text>
        </View>
      )}

      {showVerse && (
        <TouchableOpacity style={s.row} onPress={() => router.push('/daily-verse' as Href)}>
          <MaterialIcons name="menu-book" size={17} color={C.textSec} />
          <Text style={s.rowText} numberOfLines={2} ellipsizeMode="tail">
            {verse.text} — {verse.reference}
          </Text>
        </TouchableOpacity>
      )}

      {news === 'loading' ? (
        <View style={s.row}>
          <MaterialIcons name="newspaper" size={17} color={C.textSec} />
          <ActivityIndicator size="small" color={C.textSec} style={s.rowSpinner} />
        </View>
      ) : newsList.length > 0 ? (
        <TouchableOpacity style={s.row} onPress={() => Linking.openURL(newsList[0].link)}>
          <MaterialIcons name="newspaper" size={17} color={C.textSec} />
          <View style={s.rowTextCol}>
            <Text style={s.rowMeta}>
              {newsList[0].sourceName}{formatRelativeTime(newsList[0].publishedAt) ? ` · ${formatRelativeTime(newsList[0].publishedAt)}` : ''}
            </Text>
            <Text style={s.rowText} numberOfLines={1}>{newsList[0].headline}</Text>
          </View>
        </TouchableOpacity>
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
      )}

      <TouchableOpacity style={s.doneBtn} onPress={handleDone} activeOpacity={0.7}>
        <MaterialIcons name="done" size={16} color={C.primary} />
        <Text style={s.doneText}>Done for today</Text>
      </TouchableOpacity>
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
  rowSpinner: { marginLeft: 2 },
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
