/**
 * Device-free E2EE ↔ backend integration check (Stage 4, step 6).
 *
 * Acts as the app's client using the REAL crypto (../src/crypto) against a deployed
 * backend, verifying the note-encryption contract without needing a device build:
 *   - ciphertext at rest (server never sees plaintext title/content/tags.name)
 *   - enc_version=1 persisted and returned
 *   - client decrypt round-trips
 *   - the raised size caps accept a worst-case (CJK) max note but reject an over-cap one
 *   - a partial update (linked_event_id only) preserves enc_version (backend exclude_unset)
 *
 * Requires a VERIFIED account (signup needs email verification). Run:
 *   E2EE_CHECK_EMAIL=you@example.com E2EE_CHECK_PASSWORD=... \
 *     node --import ./src/crypto/_ts-resolver.mjs scripts/e2ee-backend-check.ts
 * Optional: E2EE_CHECK_BASE_URL (defaults to the Railway prod API).
 *
 * Uses a random DEK held only in-process — enough to prove the note contract; the
 * escrow/key-bootstrap path is covered by the Stage 3 tests. Notes it creates are
 * deleted at the end (best effort).
 */
import { generateDek } from '../src/crypto/e2ee';
import { encryptNoteFields, decryptNoteFields } from '../src/crypto/noteCryptoCore';

const BASE_URL = process.env.E2EE_CHECK_BASE_URL || 'https://web-production-a3258.up.railway.app/api';
const EMAIL = process.env.E2EE_CHECK_EMAIL;
const PASSWORD = process.env.E2EE_CHECK_PASSWORD;

let passed = 0;
let failed = 0;
function ok(name: string, cond: boolean, detail = '') {
  if (cond) { passed++; console.log('  ✓', name); }
  else { failed++; console.log('  ✗', name, detail); }
}

const dek = generateDek();
const isCipher = (s: unknown) => typeof s === 'string' && /^v1\.[^.]+\.[^.]+$/.test(s);

async function api(path: string, token: string, init: RequestInit = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...(init.headers || {}),
    },
  });
  return res;
}

async function main() {
  if (!EMAIL || !PASSWORD) {
    console.error('Set E2EE_CHECK_EMAIL and E2EE_CHECK_PASSWORD (a verified account).');
    process.exit(2);
  }
  console.log(`E2EE backend check → ${BASE_URL}`);

  // --- login ---
  const loginRes = await fetch(`${BASE_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!loginRes.ok) {
    console.error('login failed', loginRes.status, await loginRes.text());
    process.exit(2);
  }
  const token: string = (await loginRes.json()).access_token;
  console.log('logged in.\n');

  const createdIds: string[] = [];
  const createNote = async (payload: any) => {
    const res = await api('/notes', token, { method: 'POST', body: JSON.stringify(payload) });
    return res;
  };

  // --- 1. round-trip: encrypt, store, fetch, decrypt ---
  console.log('round-trip (create → store → fetch → decrypt):');
  {
    const plain = { title: 'Integration secret ✓', content: 'body 北京 😀', tags: [{ name: 'work', color: '#f00' }] };
    const enc = encryptNoteFields({ ...plain }, dek);
    const res = await createNote(enc);
    ok('create accepted (200/201)', res.ok, String(res.status));
    if (res.ok) {
      const created = await res.json();
      createdIds.push(created.id);
      ok('response enc_version === 1', created.enc_version === 1);
      ok('title stored as ciphertext (not plaintext)', isCipher(created.title) && !JSON.stringify(created).includes('Integration secret'));
      ok('tag name ciphertext, color preserved', isCipher(created.tags?.[0]?.name) && created.tags?.[0]?.color === '#f00');

      const getRes = await api(`/notes/${created.id}`, token);
      const fetched = await getRes.json();
      ok('GET returns ciphertext at rest', isCipher(fetched.title) && fetched.enc_version === 1);
      const dec = decryptNoteFields(fetched, dek);
      ok('title decrypts to original', dec.title === plain.title);
      ok('content decrypts (unicode)', dec.content === plain.content);
      ok('tag name decrypts, color intact', dec.tags?.[0]?.name === 'work' && dec.tags?.[0]?.color === '#f00');

      // --- partial update preserves enc_version (exclude_unset) ---
      const putRes = await api(`/notes/${created.id}`, token, { method: 'PUT', body: JSON.stringify({ linked_event_id: null }) });
      ok('partial update accepted', putRes.ok, String(putRes.status));
      const after = await (await api(`/notes/${created.id}`, token)).json();
      ok('enc_version preserved after partial update', after.enc_version === 1);
      ok('title still ciphertext after partial update', isCipher(after.title));
    }
  }

  // --- 2. caps: worst-case (CJK) max note accepted, over-cap rejected ---
  console.log('\nsize caps (deployed backend):');
  {
    const cjk = '好';
    const maxTitle = encryptNoteFields({ title: cjk.repeat(1000), content: '' }, dek); // ~4044 cipher chars
    const res = await createNote(maxTitle);
    ok('worst-case 1000-char CJK title accepted (not 413)', res.ok, `status ${res.status}`);
    if (res.ok) createdIds.push((await res.json()).id);

    const overTitle = encryptNoteFields({ title: cjk.repeat(1400), content: '' }, dek); // ~5600 cipher chars > 5000 cap
    const overRes = await createNote(overTitle);
    ok('over-cap title rejected with 413', overRes.status === 413, `status ${overRes.status}`);
  }

  // --- cleanup ---
  for (const id of createdIds) {
    try { await api(`/notes/${id}`, token, { method: 'DELETE' }); } catch { /* best effort */ }
  }
  console.log(`\n${passed} passed, ${failed} failed  (${createdIds.length} test notes cleaned up)`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(2); });
