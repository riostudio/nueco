// Turns pdfExtractor/dist/index.html (built by `vite build --config pdfExtractor/vite.config.ts`)
// into a TS module exporting the HTML as a string, so it can be imported without any special
// loader. Exactly the same approach as scripts/buildWebEditorHtml.js - see that file's comment.
// Run via `npm run build:pdf-extractor`, and re-run whenever pdfExtractor/ changes; the built
// output is checked in (frontend/src/pdf/pdfExtractorHtml.ts) since Metro needs it at bundle
// time rather than generated on every install.
const fs = require('fs');
const path = require('path');

const htmlPath = path.join(__dirname, '../pdfExtractor/dist/index.html');
const outDir = path.join(__dirname, '../src/pdf');
const outPath = path.join(outDir, 'pdfExtractorHtml.ts');

const html = fs.readFileSync(htmlPath, 'utf8');
const content =
  '// @ts-nocheck\n' +
  '/* eslint-disable */\n' +
  '// GENERATED FILE - do not edit by hand. Run `npm run build:pdf-extractor` to regenerate\n' +
  '// (see scripts/buildPdfExtractorHtml.js and pdfExtractor/).\n' +
  `export const pdfExtractorHtml = ${JSON.stringify(html)};\n`;

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(outPath, content);
console.log(`Built PDF extractor HTML -> ${outPath} (${(html.length / 1024).toFixed(1)} KB)`);
