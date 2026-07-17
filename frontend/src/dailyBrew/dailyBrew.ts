import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import { eventsApi, dailyBrewApi } from '../api';
import { decryptEventsFromServer } from '../crypto/eventCrypto';
import { eventOccursOnDay } from '../recurrence';
import { CalendarEvent } from '../types';
import { C } from '../theme';

let ExpoLocation: typeof import('expo-location') | null = null;
if (Platform.OS !== 'web') {
  try { ExpoLocation = require('expo-location'); } catch {}
}

const CACHE_PREFIX = 'dailybrew:cache:';
const DISMISSED_PREFIX = 'dailybrew:dismissed:';

export function getTodayKey(d: Date = new Date()): string {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export async function isDismissedToday(): Promise<boolean> {
  return (await AsyncStorage.getItem(`${DISMISSED_PREFIX}${getTodayKey()}`)) === '1';
}

export async function markDismissedToday(): Promise<void> {
  await AsyncStorage.setItem(`${DISMISSED_PREFIX}${getTodayKey()}`, '1');
}

export type NewsItem = {
  headline: string;
  link: string;
  sourceName: string;
  publishedAt: string | null;
};

export type CachedBrew = {
  event?: { id: string; title: string; startTime: string } | null;
  weather?: { tempC: number; condition: string; icon: string; color: string; place: string } | null;
  news?: NewsItem[];
  fetchedAt: number;
};

export async function getCachedBrew(): Promise<CachedBrew | null> {
  const raw = await AsyncStorage.getItem(`${CACHE_PREFIX}${getTodayKey()}`);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as CachedBrew;
  } catch {
    return null;
  }
}

// Merge-on-write so independently-resolving fetches (event/weather/news) don't clobber each
// other's already-cached fields.
export async function setCachedBrew(partial: Partial<CachedBrew>): Promise<void> {
  const existing = (await getCachedBrew()) ?? { fetchedAt: 0 };
  const merged: CachedBrew = { ...existing, ...partial, fetchedAt: Date.now() };
  await AsyncStorage.setItem(`${CACHE_PREFIX}${getTodayKey()}`, JSON.stringify(merged));
}

export async function pruneOldKeys(): Promise<void> {
  try {
    const todayKey = getTodayKey();
    const allKeys = await AsyncStorage.getAllKeys();
    const staleKeys = allKeys.filter((k) => k.startsWith('dailybrew:') && !k.endsWith(todayKey));
    if (staleKeys.length > 0) await AsyncStorage.multiRemove(staleKeys);
  } catch (e) {
    console.error('Failed to prune old Daily Brew keys:', e);
  }
}

export async function fetchNextEventToday(): Promise<{ id: string; title: string; startTime: string } | null> {
  try {
    const now = new Date();
    const events = await decryptEventsFromServer<CalendarEvent>(
      await eventsApi.getAll(now.getMonth() + 1, now.getFullYear())
    );
    const todays = events
      .filter((e) => eventOccursOnDay(e, now.getFullYear(), now.getMonth(), now.getDate()))
      .sort((a, b) => new Date(a.start_time).getTime() - new Date(b.start_time).getTime());
    if (todays.length === 0) return null;
    const upcoming = todays.find((e) => new Date(e.start_time).getTime() >= now.getTime());
    const chosen = upcoming ?? todays[0];
    return { id: chosen.id, title: chosen.title, startTime: chosen.start_time };
  } catch (e) {
    console.error('Failed to fetch next event today:', e);
    return null;
  }
}

// Icon color is condition-specific (not the flat C.textSec used by the card's other row icons) -
// sun/rain/snow/storm each get their own tint so the weather glyph reads at a glance.
const SUN_COLOR = '#F2B23C';
const STORM_COLOR = '#5E35B1';

function weatherCodeToConditionIcon(code: number): { condition: string; icon: string; color: string } {
  if (code <= 1) return { condition: 'Clear', icon: 'wb-sunny', color: SUN_COLOR };
  if (code <= 3) return { condition: 'Cloudy', icon: 'wb-cloudy', color: C.borderSub };
  if (code >= 45 && code <= 48) return { condition: 'Foggy', icon: 'foggy', color: C.borderSub };
  if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82))
    return { condition: 'Rainy', icon: 'umbrella', color: C.secondary };
  if ((code >= 71 && code <= 77) || (code >= 85 && code <= 86))
    return { condition: 'Snowy', icon: 'ac-unit', color: C.secondaryLight };
  if (code >= 95 && code <= 99) return { condition: 'Stormy', icon: 'thunderstorm', color: STORM_COLOR };
  return { condition: 'Cloudy', icon: 'cloud', color: C.borderSub };
}

export async function fetchWeather(): Promise<
  { tempC: number; condition: string; icon: string; color: string; place: string } | 'denied' | 'error'
> {
  if (!ExpoLocation) return 'error';
  try {
    const { status } = await ExpoLocation.requestForegroundPermissionsAsync();
    if (status !== 'granted') return 'denied';
    const pos = await ExpoLocation.getCurrentPositionAsync({ accuracy: ExpoLocation.Accuracy.Balanced });
    const { latitude, longitude } = pos.coords;
    const [weatherRes, [place]] = await Promise.all([
      fetch(
        `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,weather_code&temperature_unit=celsius`
      ),
      ExpoLocation.reverseGeocodeAsync({ latitude, longitude }),
    ]);
    if (!weatherRes.ok) return 'error';
    const data = await weatherRes.json();
    const tempC = data?.current?.temperature_2m;
    const code = data?.current?.weather_code;
    if (typeof tempC !== 'number' || typeof code !== 'number') return 'error';
    const { condition, icon, color } = weatherCodeToConditionIcon(code);
    return { tempC, condition, icon, color, place: place?.city || place?.region || '' };
  } catch (e) {
    console.error('Failed to fetch weather:', e);
    return 'error';
  }
}

export async function fetchNewsHeadlines(): Promise<NewsItem[]> {
  try {
    return await dailyBrewApi.getHeadlines();
  } catch (e) {
    console.error('Failed to fetch news headlines:', e);
    return [];
  }
}
