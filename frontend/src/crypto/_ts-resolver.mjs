/**
 * Test-only module resolver. The crypto modules use extensionless relative imports
 * (e.g. `import … from './e2ee'`) — the Metro/Expo convention used across the app.
 * Plain `node file.ts` runs the framework-free unit tests but Node's ESM resolver
 * doesn't guess extensions, so an extensionless relative import fails to resolve.
 *
 * This hook retries such specifiers with a `.ts` extension. It is loaded via
 * `node --import ./src/crypto/_ts-resolver.mjs …` (see the `test:crypto` script) and
 * never ships in the app bundle.
 */
import { registerHooks } from 'node:module';

registerHooks({
  resolve(specifier, context, nextResolve) {
    const isRelative = specifier.startsWith('./') || specifier.startsWith('../');
    const hasExt = /\.[cm]?[jt]sx?$/.test(specifier);
    if (isRelative && !hasExt) {
      try {
        return nextResolve(specifier + '.ts', context);
      } catch {
        // fall through to the default resolution (surfaces the original error)
      }
    }
    return nextResolve(specifier, context);
  },
});
