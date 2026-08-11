/**
 * On-device PDF text extraction, run inside a hidden WebView.
 *
 * Why a WebView at all: PDF.js is a browser library. In bare React Native it needs worker and
 * polyfill wiring to work at all; inside a WebView it's just running in its native habitat, no
 * shims. This is the same "bundle a web app into one HTML string and hand it to a WebView"
 * pattern webEditor/ already uses for the note editor - see webEditor/vite.config.ts and
 * scripts/buildWebEditorHtml.js. This bundle is deliberately SEPARATE from webEditor's so PDF.js
 * (~1MB+) isn't loaded on every note open for a feature used occasionally.
 *
 * Why on-device at all: note bodies are E2EE - the server can't read them. Extracting PDF text
 * server-side would have put the user's document through our backend in plaintext, contradicting
 * that guarantee (and requiring a network round trip). Everything here stays on the phone.
 */
import * as pdfjsLib from 'pdfjs-dist';
// Inlined as a string by Vite (`?raw`) then handed to PDF.js as a blob URL. PDF.js normally
// fetches its worker as a separate file, which a single-file WebView bundle has no way to serve -
// there's no origin to fetch from. A blob URL sidesteps that: the worker source travels inside
// this same HTML string and is materialised at runtime.
import pdfWorkerSource from 'pdfjs-dist/build/pdf.worker.min.mjs?raw';

pdfjsLib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(
  new Blob([pdfWorkerSource], { type: 'application/javascript' })
);

declare global {
  interface Window {
    ReactNativeWebView?: { postMessage: (message: string) => void };
  }
}

type ExtractRequest = { type: 'extract'; id: string; base64: string };

function post(message: Record<string, unknown>): void {
  try {
    window.ReactNativeWebView?.postMessage(JSON.stringify(message));
  } catch {
    // Nothing useful to do here - the native side's own per-request timeout will surface it.
  }
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function extractText(base64: string): Promise<string> {
  const doc = await pdfjsLib.getDocument({ data: base64ToBytes(base64) }).promise;
  const pages: string[] = [];
  for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
    try {
      const page = await doc.getPage(pageNum);
      const content = await page.getTextContent();
      // `str` is per-text-run, not per-line; joining with a space is the closest cheap
      // approximation of reading order without doing full layout analysis.
      const text = content.items
        .map((item: any) => (typeof item?.str === 'string' ? item.str : ''))
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (text) pages.push(text);
    } catch {
      // One unreadable page must not lose the whole document - skip it and keep going.
    }
  }
  // Release the parsed document's memory before the next PDF in a batch is loaded. Typed as
  // optional because the exact cleanup method has moved around across pdfjs major versions.
  try {
    await (doc as any)?.destroy?.();
  } catch {
    // Best-effort cleanup only.
  }
  return pages.join('\n\n');
}

async function handleRequest(req: ExtractRequest): Promise<void> {
  try {
    const text = await extractText(req.base64);
    // The `id` echo is load-bearing: several PDFs can be queued in one import, and the native
    // side matches responses to requests by id rather than assuming they come back in order.
    post({ type: 'extract-result', id: req.id, text });
  } catch (e: any) {
    post({ type: 'extract-error', id: req.id, error: String(e?.message || e) });
  }
}

function onMessage(event: MessageEvent): void {
  let parsed: ExtractRequest;
  try {
    parsed = JSON.parse(typeof event.data === 'string' ? event.data : '');
  } catch {
    return;
  }
  if (parsed?.type === 'extract' && typeof parsed.id === 'string') {
    void handleRequest(parsed);
  }
}

// Both listeners on purpose: react-native-webview delivers postMessage on `window` on some
// platforms and `document` on others - the note editor's own bridge does the same thing.
window.addEventListener('message', onMessage as EventListener);
document.addEventListener('message', onMessage as unknown as EventListener);

// Tells the native side the bundle has parsed and PDF.js is wired up. Until this lands, any
// request posted in would be dropped silently (the listeners above wouldn't exist yet).
post({ type: 'extractor-ready' });
