/**
 * Picks a glanceable emoji for an event from its title.
 *
 * WHY LOCAL RATHER THAN ASKING THE MODEL
 * The AI already parses events out of speech, so an emoji field would have been nearly free to add
 * to that call. It was deliberately not done that way: voice capture works offline, and an event
 * dictated on a site with no signal queues locally. If the emoji came from the model, exactly the
 * users this app was built for - the ones without reliable signal - would get plain rows while
 * someone on office wifi got the useful version. A local map gives everyone the same thing, in
 * microseconds, with no round trip and nothing inferred about the user's life on a server.
 *
 * WHAT THIS IS AND ISN'T
 * A quiet visual aid, never a claim. No match returns null and the row renders exactly as it does
 * today - there is deliberately no generic fallback, because a calendar glyph on every single row
 * carries no information and just adds noise to a list that's meant to be scannable. Nothing here
 * is ever shown as a category the app asserts.
 *
 * Framework-agnostic (no react/react-native/expo imports) per CLAUDE.md, so it's unit-testable in
 * plain node.
 */

/**
 * Multi-word matches, checked before single words so the more specific reading wins:
 * "birthday party" should be a cake, not a party popper.
 *
 * Order within this list matters - the first hit wins.
 */
const PHRASES: ReadonlyArray<readonly [string, string]> = [
  ['birthday party', '🎂'],
  ['drop off', '🚸'],
  ['pick up', '🚸'],
  ['school run', '🚸'],
  ['site visit', '🏗️'],
  ['job site', '🏗️'],
  ['car service', '🚗'],
  ['grocery shop', '🛒'],
  ['food shop', '🛒'],
  ['dentist appointment', '🦷'],
  ['doctor appointment', '🩺'],
  ['ulang tahun', '🎂'],   // Indonesian: birthday
  ['cuci baju', '🧺'],     // Indonesian: laundry
];

/**
 * Single-token matches. Keys are matched against whole words only, so "ping" never matches "pin"
 * and "rate" never matches "grate".
 */
const WORDS: Readonly<Record<string, string>> = {
  // Health
  dentist: '🦷', dental: '🦷', teeth: '🦷', tooth: '🦷', gigi: '🦷',
  doctor: '🩺', dr: '🩺', gp: '🩺', clinic: '🩺', hospital: '🏥', dokter: '🩺',
  medication: '💊', meds: '💊', pills: '💊', prescription: '💊', pharmacy: '💊', chemist: '💊', obat: '💊',
  physio: '🧘', chiro: '🧘', massage: '💆',
  vaccine: '💉', vaccination: '💉', jab: '💉', bloods: '💉',
  optometrist: '👓', optical: '👓',
  vet: '🐾',
  // Travel
  flight: '✈️', plane: '✈️', airport: '✈️', pesawat: '✈️', bandara: '✈️',
  train: '🚆', kereta: '🚆',
  bus: '🚌', ferry: '⛴️',
  hotel: '🏨', checkin: '🏨',
  trip: '🧳', holiday: '🧳', vacation: '🧳', liburan: '🧳',
  taxi: '🚕', uber: '🚕',
  // Work
  meeting: '👥', standup: '👥', catchup: '👥', sync: '👥', rapat: '👥', meet: '👥',
  interview: '💼',
  deadline: '⏰', due: '⏰',
  invoice: '🧾', receipt: '🧾', tax: '🧾',
  quote: '📄', estimate: '📄', contract: '📄',
  site: '🏗️', inspection: '🔍', install: '🔧', repair: '🔧', maintenance: '🔧', service: '🔧',
  delivery: '📦', parcel: '📦',
  call: '📞', phone: '📞', ring: '📞', telepon: '📞',
  presentation: '📊', demo: '📊', report: '📊',
  // Money
  rent: '💰', mortgage: '💰', bill: '💰', payment: '💰', pay: '💰', bank: '🏦', bayar: '💰',
  // Personal
  birthday: '🎂', anniversary: '💐', wedding: '💒', funeral: '🕊️',
  dinner: '🍽️', lunch: '🍽️', breakfast: '🍽️', brunch: '🍽️', makan: '🍽️',
  coffee: '☕', kopi: '☕',
  drinks: '🍻', pub: '🍻', beer: '🍻',
  gym: '🏋️', workout: '🏋️', training: '🏋️', olahraga: '🏋️',
  run: '🏃', running: '🏃', swim: '🏊', yoga: '🧘',
  football: '⚽', soccer: '⚽', footy: '🏉', cricket: '🏏', tennis: '🎾', golf: '⛳',
  movie: '🎬', cinema: '🎬', concert: '🎵', gig: '🎵',
  party: '🎉',
  // Home and errands
  groceries: '🛒', shopping: '🛒', belanja: '🛒',
  laundry: '🧺', washing: '🧺',
  haircut: '💇', barber: '💇',
  car: '🚗', rego: '🚗', mechanic: '🚗',
  school: '🏫', class: '📚', lecture: '📚', exam: '📚', study: '📚', assignment: '📚',
  church: '⛪', prayer: '🙏',
};

/**
 * The emoji for an event title, or null when nothing matches.
 *
 * Matching is whole-word and case-insensitive. Punctuation and digits are treated as separators so
 * "Dentist, 4:30pm" and "call Mum!" still match.
 */
export function emojiForEvent(title: string | null | undefined): string | null {
  const text = (title || '').toLowerCase().trim();
  if (!text) return null;

  // Normalise separators once, so phrase matching and word matching agree on what a word is.
  const normalised = text.replace(/[^a-zÀ-ɏ]+/g, ' ').trim();
  if (!normalised) return null;

  for (const [phrase, emoji] of PHRASES) {
    if (normalised.includes(phrase)) return emoji;
  }

  for (const word of normalised.split(' ')) {
    const hit = WORDS[word];
    if (hit) return hit;
  }

  return null;
}

/**
 * The title with its emoji in front, or the title unchanged when nothing matched.
 *
 * Returns a plain string rather than markup so callers drop it straight into their existing
 * <Text> - no extra view, no layout change, and `numberOfLines` truncation behaves as before.
 */
export function prefixEmoji(title: string | null | undefined): string {
  const text = title || '';
  const emoji = emojiForEvent(text);
  return emoji ? `${emoji} ${text}` : text;
}
