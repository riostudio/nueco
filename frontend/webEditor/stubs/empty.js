// Build-time stub for native-only modules that some @10play/tentap-editor internals `require()`
// inside a try/catch purely to detect "are we running on Expo" (see
// node_modules/@10play/tentap-editor/src/utils/misc.ts's isExpo()). That guard is meant to
// tolerate the module being absent at runtime, but Vite/Rolldown still statically resolves and
// bundles whatever a literal `require('...')` string points at, at build time - pulling in real
// react-native code (Flow syntax, unparseable here) even though this bundle never executes on a
// device. See webEditor/vite.config.ts's `resolve.alias`.
module.exports = {};
