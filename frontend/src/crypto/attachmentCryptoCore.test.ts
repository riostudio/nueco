/**
 * Unit tests for the chunked attachment encryption core. Runnable without a test framework:
 *   node --import ./src/crypto/_ts-resolver.mjs src/crypto/attachmentCryptoCore.test.ts
 * Exits non-zero on any failure.
 *
 * The tamper cases matter as much as the round-trip ones: chunked encryption is only as good as
 * its chunk binding, and a scheme that round-trips perfectly can still be trivially reorderable.
 */
import { generateDek } from './e2ee.ts';
import {
  encryptChunk,
  decryptChunk,
  buildHeader,
  hasAttachmentHeader,
  readHeaderVersion,
  readFrameLength,
  encryptedSizeFor,
  ATTACHMENT_FORMAT_VERSION,
  HEADER_BYTES,
  CHUNK_SIZE,
  FRAME_OVERHEAD_BYTES,
} from './attachmentCryptoCore.ts';

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

function throws(fn: () => unknown): boolean {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
}

function bytes(...vals: number[]): Uint8Array {
  return new Uint8Array(vals);
}

const key = generateDek();
const otherKey = generateDek();

console.log('attachment crypto core');

// --- header ---------------------------------------------------------------
const header = buildHeader();
ok('header is the documented size', header.length === HEADER_BYTES);
ok('header is recognised', hasAttachmentHeader(header));
ok('header carries the format version', readHeaderVersion(header) === ATTACHMENT_FORMAT_VERSION);
ok('a legacy plaintext file is not mistaken for encrypted', !hasAttachmentHeader(bytes(0x25, 0x50, 0x44, 0x46, 0x2d))); // "%PDF-"
ok('short input does not false-positive', !hasAttachmentHeader(bytes(0x4e, 0x55)));

// --- round trip -----------------------------------------------------------
const plain = new Uint8Array(5000);
for (let i = 0; i < plain.length; i++) plain[i] = i % 256;

const frame = encryptChunk(plain, key, 0, true);
const ctLen = readFrameLength(frame, 0);
ok('frame length prefix matches the ciphertext', ctLen === frame.length - 4 - 12);
const body = frame.subarray(4);
const out = decryptChunk(body, key, 0, true);
ok('round-trips to identical bytes', out.length === plain.length && out.every((b, i) => b === plain[i]));

// Empty chunk (a zero-byte file is a legitimate attachment).
const emptyFrame = encryptChunk(new Uint8Array(0), key, 0, true);
ok('empty chunk round-trips', decryptChunk(emptyFrame.subarray(4), key, 0, true).length === 0);

// --- ciphertext is actually different from plaintext ----------------------
ok('ciphertext does not contain the plaintext verbatim', (() => {
  const ct = frame.subarray(16);
  // Look for the plaintext's distinctive opening run in the ciphertext.
  for (let i = 0; i + 8 < ct.length; i++) {
    let match = true;
    for (let j = 0; j < 8; j++) if (ct[i + j] !== plain[j]) { match = false; break; }
    if (match) return false;
  }
  return true;
})());

// Same plaintext twice must not produce identical ciphertext (fresh nonce each time).
const a = encryptChunk(plain, key, 0, true);
const b = encryptChunk(plain, key, 0, true);
ok('same plaintext encrypts differently each time', !a.every((v, i) => v === b[i]));

// --- tamper / misuse resistance -------------------------------------------
ok('wrong key is rejected', throws(() => decryptChunk(body, otherKey, 0, true)));

ok('a reordered chunk is rejected (wrong index)', throws(() => decryptChunk(body, key, 1, true)));

ok('a truncated file is rejected (non-final chunk presented as final)', (() => {
  const midFrame = encryptChunk(plain, key, 3, false);
  return throws(() => decryptChunk(midFrame.subarray(4), key, 3, true));
})());

ok('a final chunk cannot be passed off as a middle chunk', (() => {
  const lastFrame = encryptChunk(plain, key, 3, true);
  return throws(() => decryptChunk(lastFrame.subarray(4), key, 3, false));
})());

ok('a flipped ciphertext bit is rejected', (() => {
  const tampered = frame.slice();
  tampered[tampered.length - 1] ^= 0x01;
  return throws(() => decryptChunk(tampered.subarray(4), key, 0, true));
})());

ok('a flipped nonce bit is rejected', (() => {
  const tampered = frame.slice();
  tampered[5] ^= 0x01;
  return throws(() => decryptChunk(tampered.subarray(4), key, 0, true));
})());

// --- size accounting ------------------------------------------------------
ok('encryptedSizeFor matches a real single-chunk encryption', (() => {
  const small = new Uint8Array(1234);
  const f = encryptChunk(small, key, 0, true);
  return encryptedSizeFor(small.length) === HEADER_BYTES + f.length;
})());

ok('encryptedSizeFor accounts for multiple chunks', (() => {
  const size = CHUNK_SIZE * 3 + 10;
  const expectedChunks = 4;
  return encryptedSizeFor(size) === HEADER_BYTES + size + expectedChunks * FRAME_OVERHEAD_BYTES;
})());

ok('overhead on a 100MB file stays under 0.01%', (() => {
  const size = 100 * 1024 * 1024;
  const overhead = encryptedSizeFor(size) - size;
  return overhead / size < 0.0001;
})());

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
