import { defineConfig } from 'vite';
import { resolve as resolvePath } from 'path';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';

const emptyStub = resolvePath(__dirname, './stubs/empty.js');

// Builds webEditor/ into ONE self-contained dist/index.html (JS/CSS inlined) - the WebView loads
// this as a raw HTML string (source={{ html }}), so it can't fetch separate script/style files.
// See scripts/buildWebEditorHtml.js for the step that turns the built file into a TS module, and
// app/editor.tsx's `customSource` for where it's actually used.
export default defineConfig({
  root: __dirname,
  plugins: [react(), viteSingleFile()],
  resolve: {
    // @10play/tentap-editor's package.json carries a top-level "react-native": "src/index.tsx"
    // field (for Metro) alongside its "exports" map's "./web" condition (for bundlers like this
    // one). Without pinning these explicitly, that field wins and pulls in the React-Native-
    // targeted source (which itself imports the `react-native` package - Flow syntax, fails to
    // parse here) instead of the plain-JS "/web" build this config is supposed to resolve to.
    mainFields: ['module', 'browser', 'main'],
    conditions: ['import', 'module', 'browser', 'default'],
    // expo-constants is only ever require()'d (inside a try/catch) by isExpo() in
    // @10play/tentap-editor's own internals, to pick between a real vs. shimmed height listener
    // - a code path this app never exercises (dynamicHeight is never enabled). Stub it (and
    // react-native itself, defensively) rather than let Rolldown statically bundle the real
    // native modules - see stubs/empty.js.
    alias: {
      'expo-constants': emptyStub,
      'react-native': emptyStub,
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    assetsInlineLimit: 100_000_000, // inline everything - no separate asset files in the output
    cssCodeSplit: false,
  },
});
