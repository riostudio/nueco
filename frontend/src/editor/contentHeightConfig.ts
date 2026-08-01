/**
 * Bridge whose only job is to report the note body's REAL rendered height back to native.
 * editor.tsx currently sizes the WebView box from a rough "~36 chars per line" heuristic
 * (bodyHeight), recalculated only on a 400ms debounce - because TenTap's own auto-height
 * mechanism (dynamicHeight / ContentHeightListener, a ResizeObserver on .ProseMirror) is
 * permanently stubbed to a no-op on Expo:
 *   node_modules/@10play/tentap-editor/src/webEditorUtils/contentHeight.tsx
 *     export const contentHeightListener = isExpo() ? shimmedHeightListener : new ContentHeightListener();
 * The heuristic's lag is exactly what causes the "type text, press Enter, text scrolls out of
 * view" bug: the WebView's own internal `overflow:auto` scroll region (webEditor/index.html)
 * auto-scrolls to keep the caret visible while the box is still the wrong (stale) size, then the
 * box resizes ~400ms later and that internal scroll position no longer matches anything.
 *
 * This extension replicates what the dead upstream mechanism would have done - including its own
 * fix for the identical bug (10play/10tap-editor issues #236 and #244): resetting the internal
 * scroll container's scrollTop to 0 on every height report, see
 * node_modules/@10play/tentap-editor/src/webEditorUtils/useTenTap.tsx's dynamicHeight effect -
 * but wired through our own message channel since the real one can't be un-stubbed without
 * patching node_modules.
 *
 * No TipTap node - this Extension exists purely to get onCreate() side-effect code (the
 * ResizeObserver) into the web bundle. The native side registers a same-named bridge purely so
 * the web side's whitelist filter (webEditor/Tiptap.tsx) doesn't drop it; nothing ever needs to
 * call INTO this extension, so unlike wrappedImageConfig.ts/tableBridgeConfig.ts there's no
 * onBridgeMessage/extendEditorInstance. It reports back via a raw
 * window.ReactNativeWebView.postMessage, read by editor.tsx's existing handleWebviewMessage - the
 * same pattern the 'editor-ready' signal already uses there.
 *
 * Same native/web split as tableBridgeConfig.ts (see that file's comment for exactly why): this
 * file has no BridgeExtension import at all - contentHeightBridge.ts (native) and
 * webEditor/contentHeightBridgeWeb.ts (web) each wrap this with BridgeExtension imported from
 * their own correct path.
 *
 * extendCSS below is load-bearing, not cosmetic: wrappedImageConfig.ts's images are
 * `float: left/right` (that's how the text-wrap works), and a floated element doesn't contribute
 * to its parent's height per the CSS spec unless something "clears" it - classic float-collapse.
 * Without the clearfix, `.ProseMirror`'s own box (what onCreate's ResizeObserver measures below)
 * doesn't grow to include a floated image, so this bridge would report a height that excludes it,
 * the WebView's native surface gets sized too short, and the image renders hard-clipped at that
 * boundary - the browser still paints it (`.ProseMirror` has `overflow: visible`), but nothing
 * beyond the native view's own bounds is ever shown, unlike a normal CSS overflow clip.
 */
import { Extension } from '@tiptap/core';

// Only reachable at runtime inside the WebView bundle - injected by react-native-webview itself.
// Declared locally (matching useTenTap.tsx's own declare global) since this file is also part of
// the main RN app's tsconfig program (via contentHeightBridge.ts), which doesn't pull in the
// "/web"-subpath types that would otherwise provide this ambient declaration.
declare global {
  interface Window {
    ReactNativeWebView: { postMessage: (message: string) => void };
  }
}

export const CONTENT_HEIGHT_MESSAGE_TYPE = 'note-body-content-height';

export type ContentHeightMessage = {
  type: typeof CONTENT_HEIGHT_MESSAGE_TYPE;
  payload: { height: number };
};

const ContentHeightExtension = Extension.create({
  name: 'contentHeight',

  addStorage() {
    return { observer: null as ResizeObserver | null };
  },

  onCreate() {
    const dom = this.editor.view.dom as HTMLElement;
    // The internal scroll container CSS targets (webEditor/index.html): `#root > div:nth-of-type(1)`.
    const scrollHost = document.querySelector('#root > div') as HTMLElement | null;

    const report = () => {
      const height = Math.ceil(dom.getBoundingClientRect().height);
      if (scrollHost) scrollHost.scrollTop = 0;
      try {
        window.ReactNativeWebView?.postMessage(
          JSON.stringify({ type: CONTENT_HEIGHT_MESSAGE_TYPE, payload: { height } })
        );
      } catch {}
    };

    const observer = new ResizeObserver(report);
    observer.observe(dom);
    this.storage.observer = observer;
    report();
  },

  onDestroy() {
    this.storage.observer?.disconnect();
    this.storage.observer = null;
  },
});

export const contentHeightBridgeConfig = {
  tiptapExtension: ContentHeightExtension,
  extendCSS: `
  .ProseMirror::after {
    content: '';
    display: table;
    clear: both;
  }
  `,
};
