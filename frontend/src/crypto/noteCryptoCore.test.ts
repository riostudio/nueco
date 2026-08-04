/**
 * Unit tests for the note field encryption core. Runnable without a test framework:
 *   node --experimental-default-type=module src/crypto/noteCryptoCore.test.ts
 * (Node 24 strips TS types natively.) Exits non-zero on any failure.
 */
import { generateDek, decryptString, encryptString, ENC_VERSION } from './e2ee.ts';
import {
  encryptNoteFields,
  decryptNoteFields,
  notesNeedingMigration,
  UNDECRYPTABLE_PLACEHOLDER,
} from './noteCryptoCore.ts';

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
  const note = {
    id: 'n1',
    title: 'Grocery list',
    content: 'milk, eggs, ✓ café 北京 😀',
    tags: [{ name: 'shopping', color: '#f00' }, { name: 'urgent', color: '#0f0' }],
    is_pinned: true,
  };
  const enc = encryptNoteFields(note, dek);

  ok('title is ciphertext', isCiphertext(enc.title));
  ok('content is ciphertext', isCiphertext(enc.content));
  ok('tag names are ciphertext', enc.tags!.every((t) => isCiphertext(t.name)));
  ok('tag colors stay plaintext', enc.tags![0].color === '#f00' && enc.tags![1].color === '#0f0');
  ok('enc_version stamped', enc.enc_version === ENC_VERSION);
  ok('non-encrypted fields preserved', enc.id === 'n1' && enc.is_pinned === true);
  ok('plaintext not present in ciphertext', !JSON.stringify(enc).includes('Grocery') && !JSON.stringify(enc).includes('shopping'));

  const dec = decryptNoteFields(enc, dek);
  ok('title round-trips', dec.title === note.title);
  ok('content round-trips (unicode)', dec.content === note.content);
  ok('tag names round-trip', dec.tags![0].name === 'shopping' && dec.tags![1].name === 'urgent');
  ok('tag colors preserved', dec.tags![0].color === '#f00');
  ok('enc_version cleared after decrypt', dec.enc_version === null);
  ok('other fields survive round-trip', dec.id === 'n1' && dec.is_pinned === true);
}

console.log('legacy plaintext passthrough (enc_version == null):');
{
  const dek = generateDek();
  const legacy = { id: 'n2', title: 'plain', content: 'text', tags: [{ name: 'x', color: '#fff' }] };
  const dec = decryptNoteFields(legacy, dek);
  ok('decrypt leaves plaintext note untouched', dec.title === 'plain' && dec.content === 'text');
  ok('legacy tag name untouched', dec.tags![0].name === 'x');
  ok('enc_version stays null/absent', dec.enc_version == null);
}

console.log('mixed batch (encrypted + legacy):');
{
  const dek = generateDek();
  const legacy = { id: 'a', title: 'legacy title', content: 'legacy body', enc_version: null };
  const enc = encryptNoteFields({ id: 'b', title: 'secret title', content: 'secret body' }, dek);
  const batch = [legacy, enc].map((n) => decryptNoteFields(n, dek));
  ok('legacy note renders as-is', batch[0].title === 'legacy title');
  ok('encrypted note decrypts', batch[1].title === 'secret title');
}

console.log('idempotency / no double-encrypt:');
{
  const dek = generateDek();
  const enc = encryptNoteFields({ title: 'once', content: 'body' }, dek);
  const twice = encryptNoteFields(enc, dek);
  ok('re-encrypting an encrypted note is a no-op', twice.title === enc.title && twice.content === enc.content);
  ok('still decrypts to original after double call', decryptNoteFields(twice, dek).title === 'once');
}

console.log('partial update payloads:');
{
  const dek = generateDek();
  const patch = encryptNoteFields({ content: 'updated body only', enc_version: undefined } as any, dek);
  ok('present field encrypted', isCiphertext(patch.content));
  ok('absent title not fabricated', !('title' in patch) || patch.title === undefined);
  ok('content-only payload IS stamped enc_version', patch.enc_version === ENC_VERSION);
  ok('decrypts back', decryptNoteFields(patch, dek).content === 'updated body only');
}

console.log('field-less partial (linked_event_id / is_pinned only):');
{
  const dek = generateDek();
  const linkOnly = encryptNoteFields({ linked_event_id: 'evt_1', updated_at: 'now' } as any, dek);
  ok('no enc_version stamped when nothing to encrypt', linkOnly.enc_version === undefined);
  ok('linked_event_id passes through untouched', (linkOnly as any).linked_event_id === 'evt_1');
  const pinOnly = encryptNoteFields({ is_pinned: true } as any, dek);
  ok('is_pinned-only payload not marked encrypted', pinOnly.enc_version === undefined && (pinOnly as any).is_pinned === true);
}

console.log('undecryptable field → placeholder, no throw:');
{
  const dek = generateDek();
  const enc = encryptNoteFields({ title: 'good', content: 'good' }, dek);
  // Decrypt with the WRONG key: fields can't be authenticated.
  const wrong = decryptNoteFields(enc, generateDek());
  ok('wrong-key title → placeholder', wrong.title === UNDECRYPTABLE_PLACEHOLDER);
  ok('wrong-key content → placeholder', wrong.content === UNDECRYPTABLE_PLACEHOLDER);

  // Corrupt token in an enc_version=1 note.
  const corrupt = { title: 'not-a-valid-token', content: encryptNoteFields({ content: 'ok' }, dek).content, enc_version: ENC_VERSION };
  const out = decryptNoteFields(corrupt as any, dek);
  ok('corrupt title → placeholder', out.title === UNDECRYPTABLE_PLACEHOLDER);
  ok('sibling valid field still decrypts', out.content === 'ok');
}

console.log('empty strings and empty tags:');
{
  const dek = generateDek();
  const enc = encryptNoteFields({ title: '', content: '', tags: [] }, dek);
  ok('empty title encrypts to a token', isCiphertext(enc.title));
  ok('empty tags stays empty array', Array.isArray(enc.tags) && enc.tags.length === 0);
  const dec = decryptNoteFields(enc, dek);
  ok('empty title round-trips', dec.title === '');
  ok('empty content round-trips', dec.content === '');
  // sanity: the encrypted empty title is genuinely decryptable
  ok('raw decryptString agrees', decryptString(enc.title as string, dek) === '');
}

console.log('migration selector (notesNeedingMigration):');
{
  const notes = [
    { id: 'a', title: 'plain', enc_version: null },
    { id: 'b', title: 'v1.x.y', enc_version: 1 },
    { id: 'c', title: 'no field at all' },            // enc_version absent -> legacy
    { id: 'd', title: 'v1.p.q', enc_version: 1 },
  ];
  const pending = notesNeedingMigration(notes);
  ok('selects legacy (null) and absent enc_version', pending.map((n) => n.id).join(',') === 'a,c');
  ok('skips already-encrypted notes', !pending.some((n) => n.enc_version === 1));
  ok('empty input -> empty', notesNeedingMigration([]).length === 0);
  ok('all-encrypted input -> empty (idempotent re-run)', notesNeedingMigration(notes.filter((n) => n.enc_version === 1)).length === 0);
}

{
  console.log('\nattachment filename encryption');
  const dek = generateDek();

  const note = {
    title: 't',
    content: 'c',
    attachments: [
      { id: 'a1', key: 'k1', filename: 'MRI results.pdf', mime_type: 'application/pdf', size_bytes: 10 },
    ],
  };

  const enc = encryptNoteFields(note as any, dek) as any;
  ok('filename is encrypted', enc.attachments[0].filename !== 'MRI results.pdf');
  ok('filename decrypts back', decryptString(enc.attachments[0].filename, dek) === 'MRI results.pdf');
  ok('non-sensitive attachment metadata stays readable', enc.attachments[0].key === 'k1' && enc.attachments[0].size_bytes === 10);

  const dec = decryptNoteFields(enc, dek) as any;
  ok('round-trips through decryptNoteFields', dec.attachments[0].filename === 'MRI results.pdf');

  // Backward compat: a note encrypted BEFORE filename encryption shipped carries enc_version 1
  // with a plaintext filename. It must survive decryption untouched, not become the placeholder.
  const legacy = {
    enc_version: 1,
    title: encryptString('t', dek),
    content: encryptString('c', dek),
    attachments: [{ id: 'a1', key: 'k1', filename: 'old-plaintext.pdf' }],
  };
  const legacyDec = decryptNoteFields(legacy as any, dek) as any;
  ok('legacy plaintext filename passes through unchanged', legacyDec.attachments[0].filename === 'old-plaintext.pdf');
  ok('legacy plaintext filename is not replaced by the placeholder', legacyDec.attachments[0].filename !== UNDECRYPTABLE_PLACEHOLDER);

  // Idempotence: re-encrypting an already-encrypted filename must not double-wrap it.
  const twice = encryptNoteFields({ ...note, attachments: enc.attachments } as any, dek) as any;
  ok('already-encrypted filename is not double-encrypted', decryptString(twice.attachments[0].filename, dek) === 'MRI results.pdf');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
