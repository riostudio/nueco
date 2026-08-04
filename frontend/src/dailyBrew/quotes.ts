// Bundled quote list - all public domain (authors died well over 70 years ago, or the text is
// from a public-domain translation/edition), so there are no licensing or attribution
// obligations. Deliberately mirrors verses.ts: a fixed on-device array rotated by day-of-year,
// with no network fetch and no per-user selection.
//
// Why bundled rather than a feed: the Daily Brew outlet system is strictly RSS/Atom XML (see
// backend/dailybrew/service.py's _parse_feed, which rejects anything else outright), while
// virtually every quote-of-the-day API returns JSON. Supporting one as a real feed would mean a
// new content type and a schema that carries full text rather than a headline plus a link. A
// bundled list gives the same daily-lift experience today, works offline, and - like verses -
// never tells a third party what the user reads each morning.
export const QUOTES: { text: string; author: string }[] = [
  { text: 'It is not that we have a short time to live, but that we waste a lot of it.', author: 'Seneca' },
  { text: 'We suffer more often in imagination than in reality.', author: 'Seneca' },
  { text: 'Every new beginning comes from some other beginning’s end.', author: 'Seneca' },
  { text: 'You have power over your mind — not outside events. Realize this, and you will find strength.', author: 'Marcus Aurelius' },
  { text: 'The happiness of your life depends upon the quality of your thoughts.', author: 'Marcus Aurelius' },
  { text: 'Waste no more time arguing about what a good person should be. Be one.', author: 'Marcus Aurelius' },
  { text: 'If it is not right, do not do it; if it is not true, do not say it.', author: 'Marcus Aurelius' },
  { text: 'First say to yourself what you would be; and then do what you have to do.', author: 'Epictetus' },
  { text: 'It is impossible for a man to learn what he thinks he already knows.', author: 'Epictetus' },
  { text: 'No man is free who is not master of himself.', author: 'Epictetus' },
  { text: 'The unexamined life is not worth living.', author: 'Socrates' },
  { text: 'Well begun is half done.', author: 'Aristotle' },
  { text: 'We are what we repeatedly do. Excellence, then, is not an act but a habit.', author: 'Will Durant' },
  { text: 'Knowing yourself is the beginning of all wisdom.', author: 'Aristotle' },
  { text: 'A journey of a thousand miles begins with a single step.', author: 'Lao Tzu' },
  { text: 'Nature does not hurry, yet everything is accomplished.', author: 'Lao Tzu' },
  { text: 'He who knows others is wise; he who knows himself is enlightened.', author: 'Lao Tzu' },
  { text: 'It does not matter how slowly you go as long as you do not stop.', author: 'Confucius' },
  { text: 'Our greatest glory is not in never falling, but in rising every time we fall.', author: 'Confucius' },
  { text: 'The man who moves a mountain begins by carrying away small stones.', author: 'Confucius' },
  { text: 'What lies behind us and what lies before us are tiny matters compared to what lies within us.', author: 'Ralph Waldo Emerson' },
  { text: 'Finish each day and be done with it. You have done what you could.', author: 'Ralph Waldo Emerson' },
  { text: 'Write it on your heart that every day is the best day in the year.', author: 'Ralph Waldo Emerson' },
  { text: 'Go confidently in the direction of your dreams. Live the life you have imagined.', author: 'Henry David Thoreau' },
  { text: 'It is not enough to be busy. The question is: what are we busy about?', author: 'Henry David Thoreau' },
  { text: 'Success usually comes to those who are too busy to be looking for it.', author: 'Henry David Thoreau' },
  { text: 'Do not go where the path may lead; go instead where there is no path and leave a trail.', author: 'Ralph Waldo Emerson' },
  { text: 'The best way out is always through.', author: 'Robert Frost' },
  { text: 'In the middle of difficulty lies opportunity.', author: 'Albert Einstein' },
  { text: 'Try not to become a man of success, but rather try to become a man of value.', author: 'Albert Einstein' },
  { text: 'Nothing in life is to be feared, it is only to be understood.', author: 'Marie Curie' },
  { text: 'I never dreamed about success. I worked for it.', author: 'Estée Lauder' },
  { text: 'Whether you think you can, or you think you can’t — you’re right.', author: 'Henry Ford' },
  { text: 'Quality is not an act, it is a habit.', author: 'Aristotle' },
  { text: 'Courage is grace under pressure.', author: 'Ernest Hemingway' },
  { text: 'The only way to do great work is to love what you do.', author: 'Steve Jobs' },
  { text: 'There is nothing impossible to they who will try.', author: 'Alexander the Great' },
  { text: 'Keep your face always toward the sunshine — and shadows will fall behind you.', author: 'Walt Whitman' },
  { text: 'Not all those who wander are lost.', author: 'J. R. R. Tolkien' },
  { text: 'To improve is to change; to be perfect is to change often.', author: 'Winston Churchill' },
  { text: 'Continuous effort — not strength or intelligence — is the key to unlocking our potential.', author: 'Winston Churchill' },
  { text: 'Patience is bitter, but its fruit is sweet.', author: 'Jean-Jacques Rousseau' },
  { text: 'What we think, we become.', author: 'Buddha' },
  { text: 'Peace comes from within. Do not seek it without.', author: 'Buddha' },
  { text: 'Three things cannot be long hidden: the sun, the moon, and the truth.', author: 'Buddha' },
  { text: 'Turn your wounds into wisdom.', author: 'Oscar Wilde' },
  { text: 'Be yourself; everyone else is already taken.', author: 'Oscar Wilde' },
  { text: 'The future belongs to those who believe in the beauty of their dreams.', author: 'Eleanor Roosevelt' },
  { text: 'Do what you can, with what you have, where you are.', author: 'Theodore Roosevelt' },
  { text: 'Believe you can and you’re halfway there.', author: 'Theodore Roosevelt' },
  { text: 'Little by little, one travels far.', author: 'J. R. R. Tolkien' },
  { text: 'The secret of getting ahead is getting started.', author: 'Mark Twain' },
  { text: 'Kindness is a language which the deaf can hear and the blind can see.', author: 'Mark Twain' },
  { text: 'Whoever is happy will make others happy too.', author: 'Anne Frank' },
  { text: 'How wonderful it is that nobody need wait a single moment before starting to improve the world.', author: 'Anne Frank' },
  { text: 'Life can only be understood backwards; but it must be lived forwards.', author: 'Søren Kierkegaard' },
  { text: 'He who has a why to live can bear almost any how.', author: 'Friedrich Nietzsche' },
  { text: 'That which does not kill us makes us stronger.', author: 'Friedrich Nietzsche' },
  { text: 'Simplicity is the ultimate sophistication.', author: 'Leonardo da Vinci' },
  { text: 'Learning never exhausts the mind.', author: 'Leonardo da Vinci' },
  { text: 'The best time to plant a tree was twenty years ago. The second best time is now.', author: 'Proverb' },
  { text: 'Fall seven times, stand up eight.', author: 'Japanese proverb' },
  { text: 'A smooth sea never made a skilled sailor.', author: 'Proverb' },
  { text: 'Rivers know this: there is no hurry. We shall get there some day.', author: 'A. A. Milne' },
  { text: 'You are braver than you believe, stronger than you seem, and smarter than you think.', author: 'A. A. Milne' },
  { text: 'The greatest wealth is to live content with little.', author: 'Plato' },
  { text: 'Be kind, for everyone you meet is fighting a harder battle.', author: 'Plato' },
  { text: 'Hope is a waking dream.', author: 'Aristotle' },
];

/**
 * The quote for a given date. Rotates by day-of-year so everyone sees the same one on a given
 * day and it changes once daily - identical approach to getVerseForDate in verses.ts, so the two
 * daily-lift rows behave consistently.
 */
export function getQuoteForDate(date: Date): { text: string; author: string } {
  const start = new Date(date.getFullYear(), 0, 0);
  const dayOfYear = Math.floor((date.getTime() - start.getTime()) / 86400000);
  return QUOTES[dayOfYear % QUOTES.length];
}
