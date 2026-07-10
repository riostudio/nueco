/**
 * Unit tests for the calendar event field encryption core. Runnable without a test
 * framework:
 *   node --experimental-default-type=module src/crypto/eventCryptoCore.test.ts
 * (Node 24 strips TS types natively.) Exits non-zero on any failure.
 */
import { generateDek, decryptString, ENC_VERSION } from './e2ee.ts';
import {
  encryptEventFields,
  decryptEventFields,
  eventsNeedingMigration,
  UNDECRYPTABLE_PLACEHOLDER,
} from './eventCryptoCore.ts';

let passed = 0;
let failed = 0;

function ok(name: string, cond: boolean, detail = '') {
  if (cond) {
    passed++;
    console.log('  ✓', name);
  } else {
    failed++;
    console.log('  ✗', name, detail);
  }
}

const isCiphertext = (s: unknown) => typeof s === 'string' && /^v1\.[^.]+\.[^.]+$/.test(s);

console.log('encrypt → decrypt round-trip:');
{
  const dek = generateDek();
  const event = {
    id: 'e1',
    title: 'Team offsite',
    description: 'Bring laptop, café 北京 😀',
    location: '123 Main St',
    start_time: '2026-08-01T09:00:00.000Z',
    reminder_minutes: 15,
  };
  const enc = encryptEventFields(event, dek);

  ok('title is ciphertext', isCiphertext(enc.title));
  ok('description is ciphertext', isCiphertext(enc.description));
  ok('location is ciphertext', isCiphertext(enc.location));
  ok('enc_version stamped', enc.enc_version === ENC_VERSION);
  ok('non-encrypted fields preserved', enc.id === 'e1' && enc.start_time === '2026-08-01T09:00:00.000Z' && enc.reminder_minutes === 15);
  ok('plaintext not present in ciphertext', !JSON.stringify(enc).includes('offsite') && !JSON.stringify(enc).includes('Main St'));

  const dec = decryptEventFields(enc, dek);
  ok('title round-trips', dec.title === event.title);
  ok('description round-trips (unicode)', dec.description === event.description);
  ok('location round-trips', dec.location === event.location);
  ok('enc_version cleared after decrypt', dec.enc_version === null);
  ok('other fields survive round-trip', dec.id === 'e1' && dec.reminder_minutes === 15);
}

console.log('legacy plaintext passthrough (enc_version == null):');
{
  const dek = generateDek();
  const legacy = { id: 'e2', title: 'plain', description: 'text', location: 'nowhere' };
  const dec = decryptEventFields(legacy, dek);
  ok('decrypt leaves plaintext event untouched', dec.title === 'plain' && dec.description === 'text' && dec.location === 'nowhere');
  ok('enc_version stays null/absent', dec.enc_version == null);
}

console.log('mixed batch (encrypted + legacy):');
{
  const dek = generateDek();
  const legacy = { id: 'a', title: 'legacy title', description: 'legacy body', enc_version: null };
  const enc = encryptEventFields({ id: 'b', title: 'secret title', description: 'secret body' }, dek);
  const batch = [legacy, enc].map((e) => decryptEventFields(e, dek));
  ok('legacy event renders as-is', batch[0].title === 'legacy title');
  ok('encrypted event decrypts', batch[1].title === 'secret title');
}

console.log('idempotency / no double-encrypt:');
{
  const dek = generateDek();
  const enc = encryptEventFields({ title: 'once', description: 'body' }, dek);
  const twice = encryptEventFields(enc, dek);
  ok('re-encrypting an encrypted event is a no-op', twice.title === enc.title && twice.description === enc.description);
  ok('still decrypts to original after double call', decryptEventFields(twice, dek).title === 'once');
}

console.log('partial update payloads:');
{
  const dek = generateDek();
  const patch = encryptEventFields({ description: 'updated body only', enc_version: undefined } as any, dek);
  ok('present field encrypted', isCiphertext(patch.description));
  ok('absent title not fabricated', !('title' in patch) || patch.title === undefined);
  ok('description-only payload IS stamped enc_version', patch.enc_version === ENC_VERSION);
  ok('decrypts back', decryptEventFields(patch, dek).description === 'updated body only');
}

console.log('field-less partial (reminder_minutes / linked_note_ids only):');
{
  const dek = generateDek();
  const reminderOnly = encryptEventFields({ reminder_minutes: 30, updated_at: 'now' } as any, dek);
  ok('no enc_version stamped when nothing to encrypt', reminderOnly.enc_version === undefined);
  ok('reminder_minutes passes through untouched', (reminderOnly as any).reminder_minutes === 30);
  const linksOnly = encryptEventFields({ linked_note_ids: ['n1'] } as any, dek);
  ok('linked_note_ids-only payload not marked encrypted', linksOnly.enc_version === undefined && (linksOnly as any).linked_note_ids[0] === 'n1');
}

console.log('undecryptable field → placeholder, no throw:');
{
  const dek = generateDek();
  const enc = encryptEventFields({ title: 'good', description: 'good' }, dek);
  // Decrypt with the WRONG key: fields can't be authenticated.
  const wrong = decryptEventFields(enc, generateDek());
  ok('wrong-key title → placeholder', wrong.title === UNDECRYPTABLE_PLACEHOLDER);
  ok('wrong-key description → placeholder', wrong.description === UNDECRYPTABLE_PLACEHOLDER);

  // Corrupt token in an enc_version=1 event.
  const corrupt = { title: 'not-a-valid-token', description: encryptEventFields({ description: 'ok' }, dek).description, enc_version: ENC_VERSION };
  const out = decryptEventFields(corrupt as any, dek);
  ok('corrupt title → placeholder', out.title === UNDECRYPTABLE_PLACEHOLDER);
  ok('sibling valid field still decrypts', out.description === 'ok');
}

console.log('empty strings:');
{
  const dek = generateDek();
  const enc = encryptEventFields({ title: '', description: '', location: '' }, dek);
  ok('empty title encrypts to a token', isCiphertext(enc.title));
  const dec = decryptEventFields(enc, dek);
  ok('empty title round-trips', dec.title === '');
  ok('empty description round-trips', dec.description === '');
  ok('empty location round-trips', dec.location === '');
  // sanity: the encrypted empty title is genuinely decryptable
  ok('raw decryptString agrees', decryptString(enc.title as string, dek) === '');
}

console.log('migration selector (eventsNeedingMigration):');
{
  const events = [
    { id: 'a', title: 'plain', enc_version: null },
    { id: 'b', title: 'v1.x.y', enc_version: 1 },
    { id: 'c', title: 'no field at all' },            // enc_version absent -> legacy
    { id: 'd', title: 'v1.p.q', enc_version: 1 },
  ];
  const pending = eventsNeedingMigration(events);
  ok('selects legacy (null) and absent enc_version', pending.map((e) => e.id).join(',') === 'a,c');
  ok('skips already-encrypted events', !pending.some((e) => e.enc_version === 1));
  ok('empty input -> empty', eventsNeedingMigration([]).length === 0);
  ok('all-encrypted input -> empty (idempotent re-run)', eventsNeedingMigration(events.filter((e) => e.enc_version === 1)).length === 0);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
