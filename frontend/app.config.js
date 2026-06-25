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
