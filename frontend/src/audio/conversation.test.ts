/**
 * Unit tests for conversation-mode policy logic. Framework-free:
 *   node --import ./src/crypto/_ts-resolver.mjs src/audio/conversation.test.ts
 */
import {
  MAX_CONVERSATION_MS,
  isSessionOverCap,
  conversationSecondsLeft,
  flagConversationRegions,
  groupSpeakerTurns,
  CONVERSATION_MODE_ENABLED,
} from './conversation.ts';
import type { WordTiming } from './retention.ts';

let passed = 0;
let failed = 0;
function ok(name: string, cond: boolean, detail = '') {
  if (cond) { passed++; console.log('  ✓', name); }
  else { failed++; console.log('  ✗', name, detail); }
}

function w(word: string, start: number, end: number, speaker?: string, confidence?: number): WordTiming {
  return { word, start, end, speaker, confidence };
}

function main() {
  console.log('conversation mode - feature gate:');
  ok('gate is on for testing (flipped by the product owner)', CONVERSATION_MODE_ENABLED === true);

  console.log('session cap:');
  ok('under cap', !isSessionOverCap(MAX_CONVERSATION_MS - 1));
  ok('at cap', isSessionOverCap(MAX_CONVERSATION_MS));
  ok('over cap', isSessionOverCap(MAX_CONVERSATION_MS + 5000));
  ok('seconds left mid-session', conversationSecondsLeft(60 * 1000) === 44 * 60);
  ok('seconds left floored at zero', conversationSecondsLeft(MAX_CONVERSATION_MS + 999) === 0);

  console.log('flagConversationRegions:');
  {
    // Clean turn-taking, no overlap, all high confidence.
    const words = [
      w('hello', 0.0, 0.5, 'S1', 0.95),
      w('there', 0.6, 1.0, 'S1', 0.9),
      w('hi', 1.2, 1.5, 'S2', 0.92),
    ];
    ok('clean turns unflagged', flagConversationRegions(words).length === 0);
  }
  {
    // Two speakers overlapping in time.
    const words = [
      w('I', 0.0, 0.6, 'S1', 0.9),
      w('actually', 0.4, 1.0, 'S2', 0.9), // starts before "I" ends, different speaker
      w('think', 1.1, 1.5, 'S2', 0.9),
    ];
    const regions = flagConversationRegions(words);
    ok('overlap flagged', regions.length === 1, JSON.stringify(regions));
    ok('overlap covers both words', regions[0]?.startWord === 0 && regions[0]?.endWord === 1, JSON.stringify(regions[0]));
    ok('overlap reason', regions[0]?.reason === 'overlap');
  }
  {
    // Word without a speaker label is unattributable -> flagged.
    const words = [
      w('a', 0.0, 0.3, 'S1', 0.9),
      w('b', 0.4, 0.7, undefined, 0.9),
      w('c', 0.9, 1.2, 'S2', 0.9),
    ];
    const regions = flagConversationRegions(words);
    ok('missing speaker flagged', regions.some(r => r.startWord === 1 && r.endWord === 1));
  }
  {
    // Low confidence without overlap gets the low-confidence reason.
    const words = [
      w('a', 0.0, 0.3, 'S1', 0.9),
      w('mumble', 0.5, 0.9, 'S1', 0.3),
      w('b', 1.0, 1.3, 'S1', 0.9),
    ];
    const regions = flagConversationRegions(words);
    ok('low confidence flagged', regions.length === 1 && regions[0].reason === 'low-confidence', JSON.stringify(regions));
  }
  {
    // Adjacent flagged words merge into one region.
    const words = [
      w('a', 0.0, 0.6, 'S1', 0.9),
      w('b', 0.4, 1.0, 'S2', 0.9),
      w('c', 0.8, 1.4, 'S1', 0.9), // overlaps "b"
    ];
    const regions = flagConversationRegions(words);
    ok('contiguous flags merge', regions.length === 1 && regions[0].startWord === 0 && regions[0].endWord === 2, JSON.stringify(regions));
  }

  console.log('groupSpeakerTurns:');
  {
    const words = [
      w('hi', 0.0, 0.3, 'S1'),
      w('there', 0.4, 0.8, 'S1'),
      w('hello', 1.0, 1.4, 'S2'),
      w('back', 1.5, 1.8, 'S1'),
    ];
    const turns = groupSpeakerTurns(words);
    ok('three turns', turns.length === 3, String(turns.length));
    ok('first turn grouped text', turns[0].text === 'hi there' && turns[0].speaker === 'S1');
    ok('second turn S2', turns[1].speaker === 'S2' && turns[1].text === 'hello');
    ok('third turn back to S1', turns[2].speaker === 'S1' && turns[2].text === 'back');
  }
  {
    const turns = groupSpeakerTurns([]);
    ok('empty words -> no turns', turns.length === 0);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
