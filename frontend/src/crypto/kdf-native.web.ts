/**
 * Web-only KDF wiring. Metro resolves this file instead of kdf-native.ts on web,
 * so react-native-quick-crypto (JSI/native) never loads in the browser.
 *
 * Pure-JS PBKDF2 is slow at DEFAULT_KDF's 600k iterations - fine for screenshot /
 * local web runs, not a substitute for the native path on device.
 */
import { pbkdf2 } from '@noble/hashes/pbkdf2.js';
import { sha256, sha512 } from '@noble/hashes/sha2.js';
import { configureKdf, type KdfParams } from './e2ee';

configureKdf((secret: Uint8Array, salt: Uint8Array, params: KdfParams): Uint8Array => {
  const hash = params.hash === 'sha256' ? sha256 : sha512;
  return pbkdf2(hash, secret, salt, { c: params.iterations, dkLen: params.dkLen });
});
