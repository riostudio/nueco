import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// Builds pdfExtractor/ into ONE self-contained dist/index.html (JS inlined, including PDF.js and
// its worker source) - the WebView loads this as a raw HTML string, so it can't fetch separate
// script files. Mirrors webEditor/vite.config.ts; see that file for the fuller explanation of the
// single-file constraint, and scripts/buildPdfExtractorHtml.js for the step that turns the built
// file into an importable TS module.
//
// No React plugin here (unlike webEditor's config): this bundle has no UI at all - it's a
// headless message handler in a hidden WebView - so pulling React in would just be dead weight.
export default defineConfig({
  root: __dirname,
  plugins: [viteSingleFile()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    assetsInlineLimit: 100_000_000, // inline everything - no separate asset files in the output
    cssCodeSplit: false,
  },
});
