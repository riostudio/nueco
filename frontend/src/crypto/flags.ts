/**
 * E2EE feature flags.
 *
 * `E2EE_KEYS_ENABLED` gates Stage 3 (key bootstrap: DEK in SecureStore, recovery
 * code). It is ON for dev + non-production builds and OFF in production until note
 * encryption (Stage 4) ships — so prod users aren't shown a recovery code for
 * encryption that isn't doing anything yet. The build-time value comes from
 * `app.config.js` (`extra.e2eeKeys = EAS_BUILD_PROFILE !== 'production'`), mirroring
 * the cleartext-traffic gating.
 */
import Constants from 'expo-constants';

export const E2EE_KEYS_ENABLED: boolean =
  __DEV__ || Constants.expoConfig?.extra?.e2eeKeys === true;
