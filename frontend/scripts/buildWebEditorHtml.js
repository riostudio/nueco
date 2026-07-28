// Turns webEditor/dist/index.html (built by `vite build --config webEditor/vite.config.ts`)
// into a TS module exporting the HTML as a string, so it can be imported without any special
// loader - same approach @10play/tentap-editor's own scripts/buildEditor.js uses for its default
// bundle. Run via `npm run build:web-editor`, and re-run whenever webEditor/ or tableBridge.ts
// changes - the built output is checked in (frontend/src/editor/customEditorHtml.ts) since Metro
// needs it at bundle time, not build-generated on every install.
const fs = require('fs');
const path = require('path');

const htmlPath = path.join(__dirname, '../webEditor/dist/index.html');
const outPath = path.join(__dirname, '../src/editor/customEditorHtml.ts');

const html = fs.readFileSync(htmlPath, 'utf8');
const content =
  '// @ts-nocheck\n' +
  '/* eslint-disable */\n' +
  '// GENERATED FILE - do not edit by hand. Run `npm run build:web-editor` to regenerate\n' +
  '// (see scripts/buildWebEditorHtml.js and webEditor/).\n' +
  `export const customEditorHtml = ${JSON.stringify(html)};\n`;

fs.writeFileSync(outPath, content);
console.log(`Built custom editor HTML -> ${outPath} (${(html.length / 1024).toFixed(1)} KB)`);
