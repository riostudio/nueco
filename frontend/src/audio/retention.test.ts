/**
 * Unit tests for audio retention policy. Framework-free:
 *   node --import ./src/crypto/_ts-resolver.mjs src/audio/retention.test.ts
 */
import {
  DEFAULT_RETENTION,
  CONVERSATION_RETENTION_MS,
  retentionMs,
  isExpired,
  findExpired,
  findExpiringSoon,
  formatBytes,
  formatClock,
  type AudioFileRecord,
} from './retention.ts';

let passed = 0;
let failed = 0;
function ok(name: string, cond: boolean, detail = '') {
  if (cond) { passed++; console.log('  ✓', name); }
  else { failed++; console.log('  ✗', name, detail); }
}

const DAY = 24 * 3600 * 1000;
const NOW = 1_000_000_000_000;

function rec(over: Partial<AudioFileRecord> = {}): AudioFileRecord {
  return { id: 'r1', uri: 'file:///x.m4a', createdAt: NOW, ...over };
}

function main() {
  console.log('audio retention:');

  ok('default retention is 30 days', DEFAULT_RETENTION === '30d');

  ok('30d: fresh recording not expired', isExpired(rec({ createdAt: NOW - DAY }), '30d', NOW) === false);
  ok('30d: 31-day-old recording expired', isExpired(rec({ createdAt: NOW - 31 * DAY }), '30d', NOW) === true);

  ok('indefinite: old recording not expired', isExpired(rec({ createdAt: NOW - 999 * DAY }), 'indefinite', NOW) === false);

  ok('immediate: not expired before transcription', isExpired(rec({ createdAt: NOW - 99 * DAY }), 'immediate', NOW) === false);
  ok('immediate: expired once transcribed', isExpired(rec({ transcribedAt: NOW }), 'immediate', NOW) === true);

  ok('conversation: expires at 24h even under indefinite',
    isExpired(rec({ conversation: true, createdAt: NOW - 25 * 3600 * 1000 }), 'indefinite', NOW) === true);
  ok('conversation: under 24h not expired even under immediate',
    isExpired(rec({ conversation: true, createdAt: NOW - 3600 * 1000 }), 'immediate', NOW) === false);
  ok('conversation ttl is 24h', retentionMs('indefinite', rec({ conversation: true })) === CONVERSATION_RETENTION_MS);

  {
    const records = [
      rec({ id: 'old', createdAt: NOW - 40 * DAY }),
      rec({ id: 'fresh', createdAt: NOW - DAY }),
      rec({ id: 'conv-old', conversation: true, createdAt: NOW - 2 * DAY }),
    ];
    const expired = findExpired(records, '30d', NOW).map(r => r.id);
    ok('findExpired picks the 40-day-old and the stale conversation', expired.join(',') === 'old,conv-old', expired.join(','));
  }

  {
    const records = [
      rec({ id: 'soon', createdAt: NOW - (30 * DAY - 2 * DAY) }),   // expires in 2 days
      rec({ id: 'later', createdAt: NOW - (30 * DAY - 10 * DAY) }), // expires in 10 days
    ];
    const soon = findExpiringSoon(records, '30d', NOW, 3 * DAY).map(r => r.id);
    ok('findExpiringSoon flags only the one inside the window', soon.join(',') === 'soon', soon.join(','));
  }

  ok('formatBytes KB', formatBytes(50 * 1024) === '50 KB');
  ok('formatBytes MB one decimal', formatBytes(2.5 * 1024 * 1024) === '2.5 MB');
  ok('formatBytes MB rounded at 100+', formatBytes(150.4 * 1024 * 1024) === '150 MB');
  ok('formatBytes zero', formatBytes(0) === '0 KB');

  ok('formatClock under a minute', formatClock(42) === '0:42');
  ok('formatClock minutes', formatClock(125) === '2:05');
  ok('formatClock zero', formatClock(0) === '0:00');
  ok('formatClock pads seconds', formatClock(61) === '1:01');
  ok('formatClock guards NaN', formatClock(Number.NaN) === '0:00');
  ok('formatClock guards negative', formatClock(-5) === '0:00');

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
