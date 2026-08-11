/**
 * Minimal stubs for native-only modules that crash Metro web (TurboModuleRegistry
 * getEnforcing). Only resolved when platform === 'web' - see metro.config.js.
 */
module.exports = {};
module.exports.default = {
  open: async () => ({ success: false, message: 'web stub' }),
  shareSingle: async () => ({ success: false, message: 'web stub' }),
  isPackageInstalled: async () => false,
};
module.exports.Social = {};
