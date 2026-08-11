// metro.config.js
const { getDefaultConfig } = require("expo/metro-config");
const path = require('path');
const { FileStore } = require('metro-cache');

const config = getDefaultConfig(__dirname);

// Use a stable on-disk store (shared across web/android)
const root = process.env.METRO_CACHE_ROOT || path.join(__dirname, '.metro-cache');
config.cacheStores = [
  new FileStore({ root: path.join(root, 'cache') }),
];

// Native-only packages that call TurboModuleRegistry.getEnforcing at import time and
// therefore crash the web bundle. Screenshot / local web runs stub them out.
const WEB_NATIVE_STUBS = new Set([
  'react-native-share',
  'react-native-quick-crypto',
  'react-native-quick-base64',
]);
const webStubPath = path.resolve(__dirname, 'src/webNativeStubs.js');
const upstreamResolve = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (platform === 'web' && WEB_NATIVE_STUBS.has(moduleName)) {
    return { type: 'sourceFile', filePath: webStubPath };
  }
  if (upstreamResolve) {
    return upstreamResolve(context, moduleName, platform);
  }
  return context.resolveRequest(context, moduleName, platform);
};

// Reduce the number of workers to decrease resource usage
config.maxWorkers = 2;

module.exports = config;
