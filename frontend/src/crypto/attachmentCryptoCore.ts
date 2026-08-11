/**
 * Chunked, authenticated encryption for attachment FILE BYTES.
 *
 * Separate from e2ee.ts's encryptString/decryptString because those encrypt a whole value in one
 * shot, holding plaintext + ciphertext + base64 of each in memory simultaneously. Attachments go
 * up to 100 MB (videos), where that approach peaks around half a gigabyte and reliably OOMs a
 * mid-range Android device. Here the file is processed in fixed-size chunks so peak memory is a
 * function of CHUNK_SIZE, not file size.
 *
 * Framework-agnostic on purpose (no expo/react-native imports) so it can be unit-tested in plain
 * node, same split as noteCryptoCore.ts vs noteCrypto.ts. File I/O lives in attachmentCrypto.ts.
 *
 * ON-DISK FORMAT
 *   header: MAGIC (8 bytes) ‖ FORMAT_VERSION (1 byte)
 *   chunk*: ciphertextLen (4 bytes, big-endian) ‖ nonce (12 bytes) ‖ ciphertext(+16-byte GCM tag)
 *
 * WHY THE AAD MATTERS
 * Encrypting each chunk independently would leave the file malleable at the chunk level even
 * though every individual chunk is authenticated: an attacker who can write to the bucket could
 * reorder chunks, duplicate one, or truncate the tail, and every remaining chunk would still
 * decrypt and authenticate cleanly. Binding each chunk to its own index AND to whether it is the
 * final chunk (via AES-GCM's additional authenticated data) makes all three detectable - a moved
 * chunk fails its index check, and a truncated file fails because the chunk that now sits at the
 * end was not authenticated as final.
 */
import { gcm } from '@noble/ciphers/aes.js';
// Same source e2ee.ts uses for nonces - see its comment on why @noble's randomBytes is the
// right CSPRNG here rather than anything from the RN side.
import { randomBytes } from '@noble/hashes/utils.js';

const MAGIC = new Uint8Array([0x4e, 0x55, 0x45, 0x43, 0x4f, 0x41, 0x54, 0x54]); // "NUECOATT"
export const ATTACHMENT_FORMAT_VERSION = 1;
export const HEADER_BYTES = MAGIC.length + 1;

const NONCE_BYTES = 12; // AES-GCM standard
const TAG_BYTES = 16; // AES-GCM auth tag, appended to ciphertext by @noble/ciphers
const LEN_BYTES = 4; // u32 big-endian ciphertext length prefix
export const FRAME_OVERHEAD_BYTES = LEN_BYTES + NONCE_BYTES + TAG_BYTES;

/** Plaintext bytes per chunk. 1 MiB keeps peak memory small while keeping per-chunk overhead
 *  (28 bytes of framing) negligible - about 0.003% growth. */
export const CHUNK_SIZE = 1024 * 1024;

/** Encrypted size for a given plaintext size - used to sanity-check/report sizes up front. */
export function encryptedSizeFor(plainSize: number): number {
  const chunks = Math.max(1, Math.ceil(plainSize / CHUNK_SIZE));
  return HEADER_BYTES + plainSize + chunks * FRAME_OVERHEAD_BYTES;
}

export function buildHeader(): Uint8Array {
  const out = new Uint8Array(HEADER_BYTES);
  out.set(MAGIC, 0);
  out[MAGIC.length] = ATTACHMENT_FORMAT_VERSION;
  return out;
}

/** True if these bytes begin with our header. Lets the download path tell an encrypted
 *  attachment from a legacy plaintext one that was uploaded before this shipped. */
export function hasAttachmentHeader(bytes: Uint8Array): boolean {
  if (bytes.length < HEADER_BYTES) return false;
  for (let i = 0; i < MAGIC.length; i++) {
    if (bytes[i] !== MAGIC[i]) return false;
  }
  return true;
}

export function readHeaderVersion(bytes: Uint8Array): number {
  return bytes[MAGIC.length];
}

function chunkAad(index: number, isLast: boolean): Uint8Array {
  const aad = new Uint8Array(5);
  new DataView(aad.buffer).setUint32(0, index, false);
  aad[4] = isLast ? 1 : 0;
  return aad;
}

/** Encrypt one plaintext chunk into a complete length-prefixed frame. */
export function encryptChunk(
  plain: Uint8Array,
  key: Uint8Array,
  index: number,
  isLast: boolean,
): Uint8Array {
  const nonce = randomBytes(NONCE_BYTES);
  const ct = gcm(key, nonce, chunkAad(index, isLast)).encrypt(plain);
  const frame = new Uint8Array(LEN_BYTES + NONCE_BYTES + ct.length);
  new DataView(frame.buffer).setUint32(0, ct.length, false);
  frame.set(nonce, LEN_BYTES);
  frame.set(ct, LEN_BYTES + NONCE_BYTES);
  return frame;
}

/** Decrypt one frame body (nonce ‖ ciphertext, i.e. after the length prefix). Throws if the
 *  chunk was tampered with, moved, duplicated, or if the file was truncated here. */
export function decryptChunk(
  frameBody: Uint8Array,
  key: Uint8Array,
  index: number,
  isLast: boolean,
): Uint8Array {
  const nonce = frameBody.subarray(0, NONCE_BYTES);
  const ct = frameBody.subarray(NONCE_BYTES);
  return gcm(key, nonce, chunkAad(index, isLast)).decrypt(ct);
}

/** Reads the u32 big-endian ciphertext length at the start of a frame. */
export function readFrameLength(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset + offset, LEN_BYTES).getUint32(0, false);
}
