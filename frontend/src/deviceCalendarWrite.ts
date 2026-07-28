/**
 * Thin infra wrapper around expo-calendar for writing an event to the device's native calendar
 * (whichever account the OS surfaces - Google, Apple/iCloud, Outlook/Exchange, etc). Extracted
 * out of event-editor.tsx's local writeToDeviceCalendar/loadCalendars so voice-event.tsx (and any
 * future caller) doesn't have to duplicate the calendar-selection + recurrence-placeholder logic.
 * event-editor.tsx keeps its own copy for now (its version is entangled with that screen's
 * calendar-picker UI state) - this is the version new callers should use.
 */
import { Platform } from 'react-native';
import { nextOccurrenceOnOrAfter } from './recurrence';
import { bumpDeviceCalendarSync } from './deviceCalendarSync';
import type { CalendarEvent, Recurrence } from './types';

let ExpoCalendar: typeof import('expo-calendar') | null = null;
if (Platform.OS !== 'web') {
  try { ExpoCalendar = require('expo-calendar'); } catch {}
}

const isWeb = Platform.OS === 'web';

export type DeviceCalendar = { id: string; title: string; source?: string; isSynced: boolean };

export async function loadWritableCalendars(opts: { prompt?: boolean } = {}): Promise<DeviceCalendar[]> {
  if (!ExpoCalendar || isWeb) return [];
  try {
    let status = (await ExpoCalendar.getCalendarPermissionsAsync()).status;
    if (status !== 'granted') {
      if (!opts.prompt) return [];
      status = (await ExpoCalendar.requestCalendarPermissionsAsync()).status;
      if (status !== 'granted') return [];
    }
    const all = await ExpoCalendar.getCalendarsAsync(ExpoCalendar.EntityTypes.EVENT);
    return all
      .filter((c: any) => c.allowsModifications)
      .map((c: any) => ({
        id: c.id as string,
        title: c.title as string,
        source: c.source?.name as string | undefined,
        // Android has no per-calendar "is local-only" flag by that name - isLocalAccount is the
        // nearest equivalent. iOS's SourceType.LOCAL ("On My iPhone") is the one that never syncs.
        isSynced: Platform.OS === 'android' ? c.source?.isLocalAccount !== true : c.source?.type !== 'local',
      }));
  } catch (e) {
    console.error('Failed to load calendars:', e);
    return [];
  }
}

export interface WriteDeviceEventInput {
  title: string;
  description: string;
  location: string;
  startDate: Date;
  endDate: Date;
  existingEventId?: string | null;
  recurrence?: Recurrence | null;
  recurrenceTimezone?: string | null;
  preferredCalendarId?: string | null;
}

/** Writes (creates, or updates if `existingEventId` is given) one event on the device's native
 * calendar, then nudges Android's account sync adapter so it reaches Google/Exchange right away
 * instead of waiting for the OS's periodic sync window (bumpDeviceCalendarSync - no-op on
 * iOS/web). Returns the device calendar event id, or null if calendar access isn't available or
 * wasn't granted - callers should treat that as "no device calendar counterpart", not an error:
 * the MemoPad event itself is unaffected. */
export async function writeEventToDeviceCalendar(input: WriteDeviceEventInput): Promise<string | null> {
  if (!ExpoCalendar || isWeb) return null;
  try {
    const cals = await loadWritableCalendars({ prompt: true });
    if (!cals.length) return null;

    let targetCalId: string | undefined =
      input.preferredCalendarId && cals.some((c) => c.id === input.preferredCalendarId)
        ? input.preferredCalendarId
        : undefined;
    if (!targetCalId) {
      if (Platform.OS === 'ios') {
        // Respects whatever the user set as their device default.
        try { targetCalId = (await ExpoCalendar.getDefaultCalendarAsync()).id; }
        catch { targetCalId = cals[0]?.id; }
      } else {
        // Prefer any account-synced calendar over a local-only one, so the event actually
        // leaves this device.
        const synced = cals.find((c) => c.isSynced);
        targetCalId = synced?.id || cals[0]?.id;
      }
    }
    if (!targetCalId) return null;

    // For a recurring event, the device-calendar entry is a plain one-off pointing at the
    // *upcoming* occurrence, not a native recurrenceRule - see deviceCalendarSync.ts's own
    // refreshRecurringDeviceCalendarEntries for why (iOS/Android weekday-index risk).
    let displayStart = input.startDate;
    let displayEnd = input.endDate;
    if (input.recurrence) {
      const durationMs = input.endDate.getTime() - input.startDate.getTime();
      const pseudoEvent = {
        start_time: input.startDate.toISOString(),
        recurrence: input.recurrence,
        timezone: input.recurrenceTimezone ?? null,
      } as unknown as CalendarEvent;
      const next = nextOccurrenceOnOrAfter(pseudoEvent, new Date());
      if (next) {
        displayStart = next;
        displayEnd = new Date(next.getTime() + durationMs);
      }
    }

    const eventDetails = {
      title: input.title,
      notes: input.description,
      location: input.location,
      startDate: displayStart,
      endDate: displayEnd,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    };

    let resultId: string;
    if (input.existingEventId) {
      try {
        await ExpoCalendar.updateEventAsync(input.existingEventId, eventDetails);
        resultId = input.existingEventId;
      } catch {
        resultId = await ExpoCalendar.createEventAsync(targetCalId, eventDetails);
      }
    } else {
      resultId = await ExpoCalendar.createEventAsync(targetCalId, eventDetails);
    }
    bumpDeviceCalendarSync();
    return resultId;
  } catch (e) {
    console.error('Failed to write to device calendar:', e);
    return null;
  }
}
