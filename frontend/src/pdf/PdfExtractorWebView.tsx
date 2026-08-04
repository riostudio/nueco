/**
 * Hidden WebView that extracts text from PDFs entirely on-device.
 *
 * The actual parsing runs inside the WebView (see pdfExtractor/index.ts) because PDF.js is a
 * browser library - in a WebView it needs no polyfills or worker shims. Nothing leaves the phone,
 * which is the point: note bodies are E2EE, so routing a user's PDF through our server to read it
 * would have contradicted that guarantee.
 *
 * Usage: mount <PdfExtractorWebView ref={r} /> somewhere always-rendered (it draws nothing), then
 * `await r.current.extractText(base64)`.
 */
import React, { forwardRef, useCallback, useImperativeHandle, useRef } from 'react';
import { View } from 'react-native';
import { WebView } from 'react-native-webview';
import { pdfExtractorHtml } from './pdfExtractorHtml';

export type PdfExtractorApi = {
  /** Resolves with the PDF's text (empty string if it has none, e.g. a scanned image). */
  extractText: (base64: string) => Promise<string>;
};

// Parsing happens on the device's CPU, so a big/complex PDF is legitimately slow - this is only a
// backstop against a request that will never answer at all (a wedged WebView), not a performance
// budget. Well past the point a user would have given up anyway.
const EXTRACT_TIMEOUT_MS = 120_000;

type Pending = { resolve: (text: string) => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> };

export const PdfExtractorWebView = forwardRef<PdfExtractorApi, {}>(function PdfExtractorWebView(_props, ref) {
  const webviewRef = useRef<WebView>(null);
  const pending = useRef(new Map<string, Pending>());
  const nextId = useRef(0);
  // The WebView takes a moment to parse ~1.7MB of inlined PDF.js. Anything posted before it
  // signals ready would hit a page with no message listeners yet and vanish silently, so requests
  // that arrive early are parked here and flushed once it reports in.
  const isReady = useRef(false);
  const queuedWhileLoading = useRef<string[]>([]);

  const send = useCallback((payload: string) => {
    if (isReady.current) {
      webviewRef.current?.postMessage(payload);
    } else {
      queuedWhileLoading.current.push(payload);
    }
  }, []);

  const settle = useCallback((id: string, apply: (p: Pending) => void) => {
    const entry = pending.current.get(id);
    if (!entry) return; // already timed out, or a response for an id we don't know
    clearTimeout(entry.timer);
    pending.current.delete(id);
    apply(entry);
  }, []);

  const handleMessage = useCallback((event: { nativeEvent: { data: string } }) => {
    let msg: any;
    try {
      msg = JSON.parse(event.nativeEvent.data);
    } catch {
      return;
    }

    if (msg?.type === 'extractor-ready') {
      isReady.current = true;
      const queued = queuedWhileLoading.current;
      queuedWhileLoading.current = [];
      queued.forEach(p => webviewRef.current?.postMessage(p));
      return;
    }
    // Responses are matched to requests by the id echoed back from the WebView, never by arrival
    // order. Several PDFs can be in flight from one import, and assuming order here would be the
    // same "last-resolved-wins instead of last-sent-wins" bug that cost this codebase a day of
    // debugging in the note editor's own content sync.
    if (msg?.type === 'extract-result' && typeof msg.id === 'string') {
      settle(msg.id, p => p.resolve(typeof msg.text === 'string' ? msg.text : ''));
    } else if (msg?.type === 'extract-error' && typeof msg.id === 'string') {
      settle(msg.id, p => p.reject(new Error(String(msg.error || 'PDF extraction failed'))));
    }
  }, [settle]);

  useImperativeHandle(ref, () => ({
    extractText: (base64: string) =>
      new Promise<string>((resolve, reject) => {
        const id = String(nextId.current++);
        const timer = setTimeout(() => {
          pending.current.delete(id);
          reject(new Error('PDF extraction timed out'));
        }, EXTRACT_TIMEOUT_MS);
        pending.current.set(id, { resolve, reject, timer });
        send(JSON.stringify({ type: 'extract', id, base64 }));
      }),
  }), [send]);

  return (
    // Zero-sized rather than display:none - a WebView with no layout box doesn't reliably run its
    // JS on Android, and this one needs to actually execute to be useful.
    <View style={{ width: 0, height: 0, opacity: 0 }} pointerEvents="none">
      <WebView
        ref={webviewRef}
        source={{ html: pdfExtractorHtml }}
        originWhitelist={['*']}
        onMessage={handleMessage}
        javaScriptEnabled
        // Local-only bundle: no network use at all, so nothing here should ever navigate.
        onShouldStartLoadWithRequest={() => false}
      />
    </View>
  );
});
