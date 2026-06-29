/**
 * Unit tests for the E2EE crypto core. Runnable without a test framework:
 *   node --experimental-default-type=module src/crypto/e2ee.test.ts
 * (Node 24 strips TS types natively.) Exits non-zero on any failure.
 */
import { pbkdf2Sync } from 'node:crypto';
import {
  generateDek,
  encryptString,
  decryptString,
  deriveKek,
  wrapKey,
  unwrapKey,
  createEscrow,
  unlockWithPassword,
  unlockWithRecovery,
  rewrapForNewPassword,
  generateRecoveryCode,
  normalizeRecoveryCode,
  toB64,
  fromB64,
  DEFAULT_KDF,
  configureKdf,
} from './e2ee.ts';

// The portable core has no built-in KDF; tests inject node:crypto's native PBKDF2
// (the app injects react-native-quick-crypto — same primitive, see kdf-native.ts).
configureKdf((secret, salt, params) =>
  new Uint8Array(pbkdf2Sync(Buffer.from(secret), Buffer.from(salt), params.iterations, params.dkLen, params.hash)));

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
function throws(name: string, fn: () => unknown) {
  try {
    fn();
    failed++;
    console.log('  ✗', name, '(expected throw, none)');
  } catch {
    passed++;
    console.log('  ✓', name);
  }
}
const eqBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);

console.log('base64:');
{
  const cases = ['', 'A', 'AB', 'ABC', 'hello world', '✓ café 北京 😀'];
  for (const c of cases) {
    const enc = new TextEncoder().encode(c);
    ok(`roundtrip ${JSON.stringify(c)}`, eqBytes(fromB64(toB64(enc)), enc));
  }
  ok('matches WHATWG btoa for ASCII', toB64(new TextEncoder().encode('hello')) === 'aGVsbG8=');
}

console.log('field encryption (AES-256-GCM):');
{
  const key = generateDek();
  const samples = ['', 'short', 'unicode ✓ café 北京 😀🎉', 'x'.repeat(5000), JSON.stringify({ a: 1, b: [2, 3] })];
  for (const s of samples) {
    const tok = encryptString(s, key);
    ok(`roundtrip len=${s.length}`, decryptString(tok, key) === s);
  }
  const tok = encryptString('secret', key);
  ok('ciphertext is not plaintext', !tok.includes('secret'));
  ok('versioned token format v1.<nonce>.<ct>', /^v1\.[^.]+\.[^.]+$/.test(tok));

  // nonce uniqueness: same plaintext+key → different tokens
  ok('nonce randomized', encryptString('same', key) !== encryptString('same', key));

  // wrong key fails (authenticated)
  throws('wrong key rejected', () => decryptString(tok, generateDek()));

  // tamper detection: flip a char in the ciphertext segment
  const parts = tok.split('.');
  const flipped = parts[2][0] === 'A' ? 'B' : 'A';
  const tampered = `${parts[0]}.${parts[1]}.${flipped}${parts[2].slice(1)}`;
  throws('tampered ciphertext rejected', () => decryptString(tampered, key));
  throws('malformed token rejected', () => decryptString('not-a-token', key));
}

console.log('KDF (pbkdf2):');
{
  const salt = fromB64(toB64(generateDek())).slice(0, 16);
  const k1 = deriveKek('correct horse', salt, DEFAULT_KDF);
  const k2 = deriveKek('correct horse', salt, DEFAULT_KDF);
  const k3 = deriveKek('correct horse!', salt, DEFAULT_KDF);
  ok('deterministic for same secret+salt', eqBytes(k1, k2));
  ok('different secret → different key', !eqBytes(k1, k3));
  ok('derives 32 bytes', k1.length === 32);
}

console.log('key wrap/unwrap:');
{
  const dek = generateDek();
  const kek = generateDek();
  const wrapped = wrapKey(dek, kek);
  ok('unwrap returns same DEK', eqBytes(unwrapKey(wrapped, kek), dek));
  throws('unwrap with wrong KEK fails', () => unwrapKey(wrapped, generateDek()));
}

console.log('escrow: signup / login / recovery:');
{
  const { dek, recoveryCode, bundle } = createEscrow('hunter2pw');
  ok('recovery code format (groups of 4)', /^([A-Z2-9]{4}-){5}[A-Z2-9]{4}$/.test(recoveryCode));
  ok('unlock with password → same DEK', eqBytes(unlockWithPassword(bundle, 'hunter2pw'), dek));
  ok('unlock with recovery code → same DEK', eqBytes(unlockWithRecovery(bundle, recoveryCode), dek));
  ok('recovery code normalization tolerant', eqBytes(unlockWithRecovery(bundle, recoveryCode.toLowerCase().replace(/-/g, ' ')), dek));
  throws('wrong password rejected', () => unlockWithPassword(bundle, 'wrongpw'));
  throws('wrong recovery code rejected', () => unlockWithRecovery(bundle, 'AAAA-BBBB-CCCC-DDDD-EEEE-FFFF'));
  ok('server never sees DEK: bundle has only wrapped blobs', !JSON.stringify(bundle).includes(toB64(dek)));
}

console.log('password reset (rewrap via recovery code):');
{
  const { dek, recoveryCode, bundle } = createEscrow('oldpassword');
  const newBundle = rewrapForNewPassword(bundle, recoveryCode, 'newpassword');
  ok('new password unlocks same DEK', eqBytes(unlockWithPassword(newBundle, 'newpassword'), dek));
  ok('recovery code still works after reset', eqBytes(unlockWithRecovery(newBundle, recoveryCode), dek));
  throws('old password no longer works', () => unlockWithPassword(newBundle, 'oldpassword'));
  // a note encrypted before reset is still readable after reset (DEK preserved)
  const note = encryptString('pre-reset note', dek);
  ok('notes survive password reset', decryptString(note, unlockWithPassword(newBundle, 'newpassword')) === 'pre-reset note');
}

console.log('recovery code helpers:');
{
  const rc = generateRecoveryCode();
  ok('normalize idempotent', normalizeRecoveryCode(normalizeRecoveryCode(rc)) === normalizeRecoveryCode(rc));
  ok('two recovery codes differ', generateRecoveryCode() !== generateRecoveryCode());
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
