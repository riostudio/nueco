/**
 * Wires a *native* PBKDF2 (react-native-quick-crypto, JSI/C++ over OpenSSL) into
 * the portable e2ee core. Importing this module once at app entry registers the
 * KDF for the whole app.
 *
 * Why native: pure-JS PBKDF2/scrypt under Hermes is unusably slow (measured
 * ~69 s/login). quick-crypto runs the same primitive in native code in tens of ms.
 *
 * MUST be imported after `react-native-get-random-values` and before any code
 * path that calls deriveKek/createEscrow/unlock* (i.e. at the top of _layout.tsx).
 */
import { pbkdf2Sync } from 'react-native-quick-crypto';
import { configureKdf, type KdfParams } from './e2ee';

configureKdf((secret: Uint8Array, salt: Uint8Array, params: KdfParams): Uint8Array => {
  // quick-crypto is a drop-in for node:crypto:
  //   pbkdf2Sync(password, salt, iterations, keylen, digest) -> Buffer
  const out = pbkdf2Sync(secret, salt, params.iterations, params.dkLen, params.hash);
  // Copy into a plain Uint8Array (out is a Buffer / Uint8Array subclass).
  return Uint8Array.from(out as unknown as ArrayLike<number>);
});
