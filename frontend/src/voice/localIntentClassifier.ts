/**
 * On-device voice-intent classification - the offline twin of POST /classify-voice-intent.
 *
 * When the device has no connection the cloud classifier is unreachable, but users still expect
 * "remind me to call Mum tomorrow at five" to become an event. This rules-and-parser approach
 * produces a VoiceIntentResult of the same shape, with confidence 'low' on every event because
 * a regex+chrono parse is genuinely less reliable than the LLM it stands in for. Captures
 * classified here are queued for a quiet cloud second pass when connectivity returns
 * (offlineSync's offlineClassifyQueue), so a better answer can still be offered later.
 *
 * Framework-agnostic (no react/react-native/expo imports) per AGENTS.md, so it is unit-testable
 * in plain node (see localIntentClassifier.test.ts).
 */
import * as chrono from 'chrono-node';
import type { ExtractedEvent, Recurrence, VoiceIntentResult } from '../types';
import { looksLikeScheduling } from './schedulingHints';

const EMPTY_RESULT: VoiceIntentResult = { intent: 'note', trip_name: null, events: [] };

// ---- Indonesian normalization -------------------------------------------------------------
// chrono-node has no id locale; rather than fork its parser we rewrite the common Indonesian
// temporal tokens into English equivalents it already understands. The rewrite happens on a copy
// used for PARSING only - titles keep the user's original words.

const ID_DAY_MAP: Record<string, string> = {
  senin: 'monday', selasa: 'tuesday', rabu: 'wednesday', kamis: 'thursday',
  jumat: 'friday', jum: 'friday', sabtu: 'saturday', minggu: 'sunday', ahad: 'sunday',
};

// Spoken numbers after jam/pukul ("jam tiga" = at 3) - chrono only understands digits.
const ID_NUMERAL_MAP: Record<string, string> = {
  satu: '1', dua: '2', tiga: '3', empat: '4', lima: '5', enam: '6',
  tujuh: '7', delapan: '8', sembilan: '9', sepuluh: '10', sebelas: '11', 'dua belas': '12',
};

function normalizeIndonesian(text: string): string {
  let out = text.toLowerCase();
  out = out.replace(/\b(besok|lusa)\b/g, m => (m === 'besok' ? 'tomorrow' : 'in 2 days'));
  out = out.replace(/\bhari\s+(\w+)/g, (m, day: string) => (ID_DAY_MAP[day] ? ID_DAY_MAP[day] : m));
  for (const [id, en] of Object.entries(ID_DAY_MAP)) {
    out = out.replace(new RegExp(`\\b${id}\\b`, 'g'), en);
  }
  out = out.replace(/\b(jam|pukul)\s+(dua belas|satu|dua|tiga|empat|lima|enam|tujuh|delapan|sembilan|sepuluh|sebelas)\b/g,
    (m, _kw: string, num: string) => `at ${ID_NUMERAL_MAP[num]}`);
  out = out.replace(/\b(jam|pukul)\s+(\d{1,2})\b/g, 'at $2');
  // Daypart hints only steer ambiguous bare hours ("jam 7" -> 7am/7pm), matching local convention.
  out = out.replace(/\bat\s+(\d{1,2})\s*(pagi)/g, 'at $1 am');
  out = out.replace(/\bat\s+(\d{1,2})\s*(siang)/g, 'at $1 pm');
  out = out.replace(/\bat\s+(\d{1,2})\s*(sore|malam)/g, (m, h: string, part: string) => {
    const hour = parseInt(h, 10);
    if (hour >= 8) return m; // already unambiguous
    return `at ${part === 'sore' && hour < 5 ? hour + 12 : hour + 12} pm`;
  });
  return out;
}

// ---- Recurrence ------------------------------------------------------------------------------

const EN_WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

function detectRecurrence(fragment: string): Recurrence | null {
  const text = fragment.toLowerCase();
  if (/\b(every day|daily|each day|setiap hari)\b/.test(text)) {
    return { freq: 'daily', byweekday: null, until: null };
  }
  if (/\b(every month|monthly|setiap bulan)\b/.test(text)) {
    return { freq: 'monthly', byweekday: null, until: null };
  }
  if (/\b(every year|annually|yearly|setiap tahun)\b/.test(text)) {
    return { freq: 'yearly', byweekday: null, until: null };
  }
  if (/\b(every|each|weekly|setiap)\b/.test(text)) {
    const days = EN_WEEKDAYS
      .map((name, i) => (new RegExp(`\\b${name}s?\\b`).test(text) ? i : -1))
      .filter(i => i >= 0);
    if (days.length > 0) return { freq: 'weekly', byweekday: days, until: null };
  }
  return null;
}

// ---- Title cleanup ---------------------------------------------------------------------------

// Scheduling verbs/framing that belong to the request, not the event: "remind me to CALL MUM"
// should be titled "Call Mum", not "Remind me to call Mum".
const LEADING_NOISE = /^(please\s+)?(remind me to|remind me|reminder to|reminder|schedule|set a reminder to|set a reminder|ingat(kan)?( untuk)?|jadwal(kan)?|ingatkan( untuk)?)\s+/i;

function cleanTitle(fragment: string, timeSpans: string[]): string {
  let title = fragment;
  // Drop the exact temporal phrases chrono matched so "call Mum tomorrow at five" -> "call Mum".
  for (const span of timeSpans) {
    const idx = title.toLowerCase().indexOf(span.toLowerCase());
    if (idx >= 0) title = title.slice(0, idx) + title.slice(idx + span.length);
  }
  title = title.replace(LEADING_NOISE, '');
  title = title.replace(/\s{2,}/g, ' ').replace(/^[\s,.:;-]+|[\s,.:;-]+$/g, '').trim();
  if (!title) title = 'Event';
  return title.charAt(0).toUpperCase() + title.slice(1);
}

// ---- Fragment splitting ------------------------------------------------------------------------
// One dictation can carry several events ("lunch with Sam at noon, then gym at 6"). Split on
// sentence boundaries and the sequencers people actually dictate, then parse each fragment.

const FRAGMENT_SPLIT = /(?:[.!?]+\s+|\s+(?:and then|then|after that|setelah itu|lalu|terus)\s+)/i;

function splitFragments(transcript: string): string[] {
  return transcript
    .split(FRAGMENT_SPLIT)
    .map(f => f.trim())
    .filter(f => f.length > 0);
}

// ---- Core classification -----------------------------------------------------------------------

export function classifyLocally(
  transcript: string,
  referenceDate?: string,
  timezone?: string,
): VoiceIntentResult {
  const text = (transcript || '').trim();
  if (!text || !looksLikeScheduling(text)) return EMPTY_RESULT;

  const refDate = referenceDate ? new Date(`${referenceDate}T00:00:00`) : new Date();
  void timezone; // chrono resolves against the device clock; timezone kept for signature parity

  const events: ExtractedEvent[] = [];
  for (const fragment of splitFragments(text)) {
    const parseTarget = normalizeIndonesian(fragment);
    const results = chrono.parse(parseTarget, refDate);
    if (results.length === 0) continue;

    // A second parse inside the same fragment ("from 3 to 5") becomes the end time.
    const start = results[0];
    const end = results.length > 1 && results[1].start.date() > start.start.date() ? results[1] : null;

    // chrono resolves bare weekdays to the NEAREST occurrence, which is last week's when said
    // early in the week - but someone dictating "meeting on Friday" means the upcoming one.
    // Shift forward a week unless the fragment is explicitly about the past.
    const startDate = start.start.date();
    const mentionsPast = /\b(yesterday|last|ago|kemarin)\b/i.test(fragment);
    if (!mentionsPast && startDate.getTime() < refDate.getTime()) {
      startDate.setDate(startDate.getDate() + 7);
    }
    events.push({
      title: cleanTitle(fragment, results.map(r => r.text)),
      start_time: startDate.toISOString(),
      end_time: end ? end.start.date().toISOString() : null,
      location: '',
      recurrence: detectRecurrence(fragment),
      confidence: 'low',
    });
  }

  if (events.length === 0) return EMPTY_RESULT;

  const lower = text.toLowerCase();
  const tripKeywords = /\b(trip|itinerary|holiday|vacation|perjalanan|liburan)\b/.test(lower);
  if (tripKeywords && events.length >= 2) {
    const nameMatch = text.match(/\b(?:trip|holiday|vacation|perjalanan|liburan)\s+(?:to|ke)\s+([A-Za-z\u00C0-\u024F ]+)/i);
    return {
      intent: 'itinerary',
      trip_name: nameMatch ? nameMatch[1].trim() : null,
      events,
    };
  }
  return {
    intent: events.length === 1 ? 'single_event' : 'multiple_events',
    trip_name: null,
    events,
  };
}

/**
 * True when a cloud re-classification meaningfully disagrees with the local one - enough to be
 * worth showing the user as an upgrade suggestion. Compares intent, event count, and per-event
 * title/start_time (start times floored to the minute: chrono and the LLM rarely agree on seconds).
 */
export function classificationsDiffer(local: VoiceIntentResult, cloud: VoiceIntentResult): boolean {
  if (local.intent !== cloud.intent) return true;
  if (local.events.length !== cloud.events.length) return true;
  const minute = (iso: string | null) => (iso ? Math.floor(new Date(iso).getTime() / 60000) : null);
  return local.events.some((ev, i) => {
    const other = cloud.events[i];
    return (
      ev.title.trim().toLowerCase() !== other.title.trim().toLowerCase() ||
      minute(ev.start_time) !== minute(other.start_time) ||
      (ev.recurrence?.freq ?? null) !== (other.recurrence?.freq ?? null)
    );
  });
}
