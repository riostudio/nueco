/**
 * Unit tests for the trip field encryption core. Runnable without a test framework:
 *   node --experimental-default-type=module src/crypto/tripCryptoCore.test.ts
 * (Node 24 strips TS types natively.) Exits non-zero on any failure.
 */
import { generateDek, decryptString, ENC_VERSION } from './e2ee.ts';
import {
  encryptTripFields,
  decryptTripFields,
  tripsNeedingMigration,
  UNDECRYPTABLE_PLACEHOLDER,
} from './tripCryptoCore.ts';

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
  const trip = {
    id: 't1',
    name: 'Tokyo trip',
    description: 'Bring passport, café 北京 😀',
    created_at: '2026-08-01T09:00:00.000Z',
  };
  const enc = encryptTripFields(trip, dek);

  ok('name is ciphertext', isCiphertext(enc.name));
  ok('description is ciphertext', isCiphertext(enc.description));
  ok('enc_version stamped', enc.enc_version === ENC_VERSION);
  ok('non-encrypted fields preserved', enc.id === 't1' && enc.created_at === '2026-08-01T09:00:00.000Z');
  ok('plaintext not present in ciphertext', !JSON.stringify(enc).includes('Tokyo') && !JSON.stringify(enc).includes('passport'));

  const dec = decryptTripFields(enc, dek);
  ok('name round-trips', dec.name === trip.name);
  ok('description round-trips (unicode)', dec.description === trip.description);
  ok('enc_version cleared after decrypt', dec.enc_version === null);
  ok('other fields survive round-trip', dec.id === 't1');
}

console.log('legacy plaintext passthrough (enc_version == null):');
{
  const dek = generateDek();
  const legacy = { id: 't2', name: 'plain', description: 'text' };
  const dec = decryptTripFields(legacy, dek);
  ok('decrypt leaves plaintext trip untouched', dec.name === 'plain' && dec.description === 'text');
  ok('enc_version stays null/absent', dec.enc_version == null);
}

console.log('mixed batch (encrypted + legacy):');
{
  const dek = generateDek();
  const legacy = { id: 'a', name: 'legacy name', description: 'legacy body', enc_version: null };
  const enc = encryptTripFields({ id: 'b', name: 'secret name', description: 'secret body' }, dek);
  const batch = [legacy, enc].map((t) => decryptTripFields(t, dek));
  ok('legacy trip renders as-is', batch[0].name === 'legacy name');
  ok('encrypted trip decrypts', batch[1].name === 'secret name');
}

console.log('idempotency / no double-encrypt:');
{
  const dek = generateDek();
  const enc = encryptTripFields({ name: 'once', description: 'body' }, dek);
  const twice = encryptTripFields(enc, dek);
  ok('re-encrypting an encrypted trip is a no-op', twice.name === enc.name && twice.description === enc.description);
  ok('still decrypts to original after double call', decryptTripFields(twice, dek).name === 'once');
}

console.log('partial update payloads:');
{
  const dek = generateDek();
  const patch = encryptTripFields({ description: 'updated body only', enc_version: undefined } as any, dek);
  ok('present field encrypted', isCiphertext(patch.description));
  ok('absent name not fabricated', !('name' in patch) || patch.name === undefined);
  ok('description-only payload IS stamped enc_version', patch.enc_version === ENC_VERSION);
  ok('decrypts back', decryptTripFields(patch, dek).description === 'updated body only');
}

console.log('field-less partial payload:');
{
  const dek = generateDek();
  const idOnly = encryptTripFields({ id: 'x', created_at: 'now' } as any, dek);
  ok('no enc_version stamped when nothing to encrypt', idOnly.enc_version === undefined);
  ok('other fields pass through untouched', (idOnly as any).id === 'x' && (idOnly as any).created_at === 'now');
}

console.log('undecryptable field → placeholder, no throw:');
{
  const dek = generateDek();
  const enc = encryptTripFields({ name: 'good', description: 'good' }, dek);
  // Decrypt with the WRONG key: fields can't be authenticated.
  const wrong = decryptTripFields(enc, generateDek());
  ok('wrong-key name → placeholder', wrong.name === UNDECRYPTABLE_PLACEHOLDER);
  ok('wrong-key description → placeholder', wrong.description === UNDECRYPTABLE_PLACEHOLDER);

  // Corrupt token in an enc_version=1 trip.
  const corrupt = { name: 'not-a-valid-token', description: encryptTripFields({ description: 'ok' }, dek).description, enc_version: ENC_VERSION };
  const out = decryptTripFields(corrupt as any, dek);
  ok('corrupt name → placeholder', out.name === UNDECRYPTABLE_PLACEHOLDER);
  ok('sibling valid field still decrypts', out.description === 'ok');
}

console.log('empty strings:');
{
  const dek = generateDek();
  const enc = encryptTripFields({ name: '', description: '' }, dek);
  ok('empty name encrypts to a token', isCiphertext(enc.name));
  const dec = decryptTripFields(enc, dek);
  ok('empty name round-trips', dec.name === '');
  ok('empty description round-trips', dec.description === '');
  // sanity: the encrypted empty name is genuinely decryptable
  ok('raw decryptString agrees', decryptString(enc.name as string, dek) === '');
}

console.log('migration selector (tripsNeedingMigration):');
{
  const trips = [
    { id: 'a', name: 'plain', enc_version: null },
    { id: 'b', name: 'v1.x.y', enc_version: 1 },
    { id: 'c', name: 'no field at all' },            // enc_version absent -> legacy
    { id: 'd', name: 'v1.p.q', enc_version: 1 },
  ];
  const pending = tripsNeedingMigration(trips);
  ok('selects legacy (null) and absent enc_version', pending.map((t) => t.id).join(',') === 'a,c');
  ok('skips already-encrypted trips', !pending.some((t) => t.enc_version === 1));
  ok('empty input -> empty', tripsNeedingMigration([]).length === 0);
  ok('all-encrypted input -> empty (idempotent re-run)', tripsNeedingMigration(trips.filter((t) => t.enc_version === 1)).length === 0);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
