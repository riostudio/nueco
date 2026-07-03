// Dynamic Expo config layered on top of app.json.
//
// Gates Android cleartext (plain HTTP) traffic to NON-production builds only.
// Cleartext is needed when EXPO_PUBLIC_BACKEND_URL points at an http:// backend
// (e.g. a LAN staging server like http://192.168.20.32:8765). Production builds
// talk to HTTPS (Railway) only, so cleartext stays disabled there to preserve the
// defense-in-depth guard (and avoid Play Store cleartext warnings).
//
// EAS sets EAS_BUILD_PROFILE during `eas build` (e.g. "preview", "production").
// Local/dev runs (undefined profile) are treated as non-production.

const isProduction = process.env.EAS_BUILD_PROFILE === 'production';

module.exports = ({ config }) => ({
  ...config,
  // Feature flags baked at build time, read at runtime via expo-constants.
  // e2eeKeys: E2EE key bootstrap (recovery code, DEK in SecureStore) AND note field
  // encryption. Now ON for ALL builds — Stage 4 shipped. IRREVERSIBLE for prod: any
  // note saved with this on is ciphertext the server can't read. Only enable in prod
  // after the §9 rollout gates (verify, Atlas snapshot, migration build).
  //
  // e2eeMigration: Stage 4 one-time eager migration of legacy plaintext notes to
  // ciphertext. OFF unless the build explicitly opts in via `E2EE_MIGRATION=1`,
  // because it rewrites every plaintext note and MUST be preceded by an Atlas
  // snapshot (see E2EE-DESIGN.md §7). This is the deliberate "run migration" trigger.
  extra: {
    ...(config.extra ?? {}),
    e2eeKeys: true,
    e2eeMigration: process.env.E2EE_MIGRATION === '1',
  },
  plugins: [
    ...(config.plugins ?? []),
    [
      'expo-build-properties',
      {
        android: {
          usesCleartextTraffic: !isProduction,
        },
      },
    ],
  ],
});
