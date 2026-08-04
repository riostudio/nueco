/**
 * Streaming file encrypt/decrypt for attachments, layered over attachmentCryptoCore.ts.
 *
 * This half owns the platform I/O (expo-file-system's stream API); the core owns the format and
 * the actual crypto, and is unit-tested in plain node. Same split as noteCrypto.ts vs
 * noteCryptoCore.ts.
 *
 * Everything here streams: a 100 MB video is processed a chunk at a time, so peak memory tracks
 * CHUNK_SIZE rather than file size. Reading such a file into memory whole (which is what
 * encryptString would have meant) peaks near half a gigabyte once you count the plaintext, the
 * ciphertext and the base64 of each - an OOM on most mid-range Android devices.
 */
import { File, Paths } from 'expo-file-system';
import {
  buildHeader,
  encryptChunk,
  decryptChunk,
  hasAttachmentHeader,
  readHeaderVersion,
  readFrameLength,
  CHUNK_SIZE,
  HEADER_BYTES,
  ATTACHMENT_FORMAT_VERSION,
} from './attachmentCryptoCore';

const NONCE_BYTES = 12;
const LEN_BYTES = 4;

/** Joins queued buffers and returns the first `count` bytes plus the remainder. */
function takeBytes(queue: Uint8Array[], count: number): { taken: Uint8Array; rest: Uint8Array[] } {
  const taken = new Uint8Array(count);
  let filled = 0;
  const rest: Uint8Array[] = [];
  for (const buf of queue) {
    if (filled >= count) {
      rest.push(buf);
      continue;
    }
    const need = count - filled;
    if (buf.length <= need) {
      taken.set(buf, filled);
      filled += buf.length;
    } else {
      taken.set(buf.subarray(0, need), filled);
      filled += need;
      rest.push(buf.subarray(need));
    }
  }
  return { taken, rest };
}

function totalLength(queue: Uint8Array[]): number {
  let n = 0;
  for (const b of queue) n += b.length;
  return n;
}

function uniqueTempFile(suffix: string): File {
  const name = `nueco-att-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${suffix}`;
  return new File(Paths.cache, name);
}

/**
 * Encrypts `srcUri` into a new file in the cache directory and returns it. The caller uploads
 * that file and is responsible for deleting it afterwards.
 */
export async function encryptFileToTemp(srcUri: string, dek: Uint8Array): Promise<File> {
  const dest = uniqueTempFile('.enc');
  dest.create({ overwrite: true });

  const reader = new File(srcUri).readableStream().getReader();
  const writer = dest.writableStream().getWriter();

  try {
    await writer.write(buildHeader());

    let queue: Uint8Array[] = [];
    let index = 0;

    // A chunk is only emitted once we know MORE data follows it, so the final chunk can be
    // correctly marked as final - that flag is authenticated, and it's what makes truncating the
    // file detectable. Hence `> CHUNK_SIZE` rather than `>=`: holding back an exactly-full buffer
    // until we've confirmed there's more keeps a file whose size is an exact multiple of
    // CHUNK_SIZE from mislabelling its last chunk.
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value?.length) queue.push(value);

      while (totalLength(queue) > CHUNK_SIZE) {
        const { taken, rest } = takeBytes(queue, CHUNK_SIZE);
        queue = rest;
        await writer.write(encryptChunk(taken, dek, index++, false));
      }
    }

    // Whatever is left is the tail. It can still exceed CHUNK_SIZE by up to one chunk, so drain
    // rather than assuming a single trailing chunk. An empty file still writes one (empty) final
    // chunk, so every file has at least one authenticated final frame.
    for (;;) {
      const remaining = totalLength(queue);
      const isLast = remaining <= CHUNK_SIZE;
      const size = isLast ? remaining : CHUNK_SIZE;
      const { taken, rest } = takeBytes(queue, size);
      queue = rest;
      await writer.write(encryptChunk(taken, dek, index++, isLast));
      if (isLast) break;
    }

    await writer.close();
    return dest;
  } catch (e) {
    try { await writer.abort(); } catch {}
    try { dest.delete(); } catch {}
    throw e;
  } finally {
    try { reader.releaseLock(); } catch {}
  }
}

/**
 * Decrypts `srcUri` into a new cache file named `filename` and returns it.
 *
 * If the source has no Nueco header it is treated as a legacy plaintext attachment (uploaded
 * before attachment encryption shipped) and simply copied through - those must keep opening
 * normally rather than failing with a decryption error.
 */
export async function decryptFileToTemp(
  srcUri: string,
  dek: Uint8Array,
  filename: string,
): Promise<File> {
  const src = new File(srcUri);
  const dest = new File(Paths.cache, `nueco-open-${Date.now()}-${filename}`);
  dest.create({ overwrite: true });

  const reader = src.readableStream().getReader();
  const writer = dest.writableStream().getWriter();

  try {
    let queue: Uint8Array[] = [];
    let headerChecked = false;
    let index = 0;
    let streamDone = false;

    const pull = async (): Promise<boolean> => {
      const { done, value } = await reader.read();
      if (done) return false;
      if (value?.length) queue.push(value);
      return true;
    };

    // Header first - it also tells us whether this is encrypted at all.
    while (totalLength(queue) < HEADER_BYTES && !streamDone) {
      if (!(await pull())) streamDone = true;
    }
    if (totalLength(queue) >= HEADER_BYTES) {
      const { taken, rest } = takeBytes(queue, HEADER_BYTES);
      if (!hasAttachmentHeader(taken)) {
        // Legacy plaintext upload: no header, so pass the bytes straight through untouched.
        await writer.write(taken);
        for (const buf of rest) await writer.write(buf);
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value?.length) await writer.write(value);
        }
        await writer.close();
        return dest;
      }
      const version = readHeaderVersion(taken);
      if (version !== ATTACHMENT_FORMAT_VERSION) {
        throw new Error(`Unsupported attachment format v${version}`);
      }
      queue = rest;
      headerChecked = true;
    }
    if (!headerChecked) throw new Error('Attachment is truncated or empty');

    for (;;) {
      while (totalLength(queue) < LEN_BYTES && !streamDone) {
        if (!(await pull())) streamDone = true;
      }
      if (totalLength(queue) < LEN_BYTES) break; // clean end of file

      const { taken: lenBytes, rest: afterLen } = takeBytes(queue, LEN_BYTES);
      queue = afterLen;
      const ctLen = readFrameLength(lenBytes, 0);
      const bodyLen = NONCE_BYTES + ctLen;

      while (totalLength(queue) < bodyLen && !streamDone) {
        if (!(await pull())) streamDone = true;
      }
      if (totalLength(queue) < bodyLen) {
        throw new Error('Attachment is truncated');
      }

      const { taken: body, rest } = takeBytes(queue, bodyLen);
      queue = rest;

      // We can't know in advance which frame is final, so try "not final" and fall back to
      // "final" - exactly one of the two authenticates, and a tampered/reordered frame
      // authenticates as neither, which is the property the AAD is there to give us.
      let plain: Uint8Array;
      try {
        plain = decryptChunk(body, dek, index, false);
      } catch {
        plain = decryptChunk(body, dek, index, true); // throws if genuinely bad
      }
      await writer.write(plain);
      index++;
    }

    await writer.close();
    return dest;
  } catch (e) {
    try { await writer.abort(); } catch {}
    try { dest.delete(); } catch {}
    throw e;
  } finally {
    try { reader.releaseLock(); } catch {}
  }
}
