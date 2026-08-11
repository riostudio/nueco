/**
 * Cheap local test for "does this dictation look like a scheduling request?"
 *
 * WHY THIS EXISTS
 * Every voice capture currently makes TWO sequential network round-trips: transcribe, then ask the
 * server to classify whether the user meant to create a calendar event. The classifier is worth
 * having - "remind me to call Mum on Tuesday at five" genuinely should become an event - but the
 * majority of dictations are ordinary notes with no temporal language at all, and for those the
 * second round-trip is pure waiting.
 *
 * This runs on-device in microseconds and skips that call when there is plainly nothing to
 * schedule. It roughly halves perceived latency for the common case, and costs nothing when it is
 * wrong in the safe direction.
 *
 * DELIBERATELY BIASED TOWARD FALSE POSITIVES
 * Saying "maybe" when the answer is no just means we make the call we would have made anyway - the
 * old behaviour, no worse. Saying "no" when the answer was yes silently loses a feature the user
 * asked for. So every rule here errs toward returning true, and anything ambiguous is a yes.
 *
 * Framework-agnostic (no react/react-native/expo imports) per CLAUDE.md, so it is unit-testable in
 * plain node.
 */

/**
 * Words that signal a time or date. Kept deliberately broad - a single hit is enough.
 *
 * Includes Indonesian alongside English: Nueco already ships Indonesian news sources and voices, so
 * an Indonesian speaker dictating "besok jam tiga" must not be silently denied event extraction.
 */
const SCHEDULING_WORDS = [
  // English - relative days
  'today', 'tomorrow', 'tonight', 'yesterday', 'weekend',
  // English - weekdays
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
  // English - months
  'january', 'february', 'march', 'april', 'may', 'june', 'july',
  'august', 'september', 'october', 'november', 'december',
  // English - clock and duration
  'am', 'pm', "o'clock", 'oclock', 'noon', 'midnight', 'midday',
  'hour', 'hours', 'minute', 'minutes', 'week', 'weeks', 'month', 'months',
  // English - intent verbs
  'remind', 'reminder', 'schedule', 'appointment', 'meeting', 'booking', 'booked',
  'calendar', 'event', 'deadline', 'due', 'flight', 'trip', 'itinerary',
  // English - recurrence
  'every', 'daily', 'weekly', 'monthly', 'annually', 'yearly', 'recurring', 'repeat',
  // English - prepositions that commonly precede a time
  'next', 'later',
  // Indonesian
  'besok', 'lusa', 'hari', 'jam', 'pukul', 'minggu', 'bulan', 'tahun',
  'senin', 'selasa', 'rabu', 'kamis', 'jumat', 'sabtu', 'ahad',
  'ingatkan', 'jadwal', 'janji', 'rapat', 'acara', 'setiap', 'nanti', 'pagi', 'siang', 'sore', 'malam',
];

// A digit followed by an optional :mm - "3pm", "at 5", "15:30". Times are the strongest signal
// there is, and plenty of phrasings carry no keyword at all ("dentist at 4:30").
const TIME_LIKE = /\b\d{1,2}([:.]\d{2})?\s*(am|pm)?\b/i;
// Numeric dates: 12/03, 3-4-2026, 2026-03-12.
const DATE_LIKE = /\b\d{1,4}[\/\-]\d{1,2}([\/\-]\d{1,4})?\b/;

const WORD_SET = new Set(SCHEDULING_WORDS);

/**
 * True when the transcript might be a scheduling request and the server classifier should run.
 *
 * Returns true for empty/garbled input too: with nothing to go on, defer to the classifier rather
 * than making the decision here.
 */
export function looksLikeScheduling(transcript: string): boolean {
  const text = (transcript || '').trim();
  if (!text) return true;

  if (TIME_LIKE.test(text) || DATE_LIKE.test(text)) return true;

  // Split on anything non-alphabetic so "Tuesday," and "3pm." still match, and so apostrophes in
  // "o'clock" survive.
  const words = text.toLowerCase().split(/[^a-z']+/);
  for (const w of words) {
    if (w && WORD_SET.has(w)) return true;
  }
  return false;
}
