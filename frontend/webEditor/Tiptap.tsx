/**
 * The actual web-side editor that runs inside the note editor's WebView. This is a custom build
 * because the default bundle @10play/tentap-editor ships (RichText/../simpleWebEditor) only
 * knows about TenTapStartKit's own built-in bridges - a native-side `bridgeExtensions` array
 * (frontend/app/editor.tsx's noteBridgeExtensions) controls what messages/state the RN side
 * sends and reads, but it does NOT add extension code to the webview: the webview's own bundle
 * has to already contain it. TableBridge (frontend/src/editor/tableBridge.ts) is a custom
 * extension the library doesn't ship, so it has to be included here, in a bundle we build
 * ourselves and hand to useEditorBridge as `customSource` - see
 * frontend/scripts/buildWebEditorHtml.js and app/editor.tsx's `customSource: customEditorHtml`.
 *
 * Mirrors @10play/tentap-editor's own src/simpleWebEditor/Tiptap.tsx, with TableBridge appended
 * and the stock PlaceholderBridge swapped for NotePlaceholderBridge (see
 * src/editor/placeholderBridgeConfig.ts - the stock one shows its ghost text on ANY empty node
 * the cursor sits in, including a freshly-toggled checklist's empty item, not just a blank note).
 */
import React from 'react';
import { EditorContent } from '@tiptap/react';
import { useTenTap, TenTapStartKit, PlaceholderBridge } from '@10play/tentap-editor/web';
import { TableBridge } from './tableBridgeWeb';
import { NotePlaceholderBridge } from './placeholderBridgeWeb';

declare global {
  interface Window {
    whiteListBridgeExtensions?: string[];
    dynamicHeight?: boolean;
  }
}

const tenTapExtensions = [
  ...TenTapStartKit.filter((e) => e !== PlaceholderBridge),
  TableBridge,
  NotePlaceholderBridge,
].filter(
  (e) =>
    !window.whiteListBridgeExtensions ||
    window.whiteListBridgeExtensions.includes(e.name)
);

export default function Tiptap() {
  const editor = useTenTap({ bridges: tenTapExtensions });

  return (
    <EditorContent
      editor={editor}
      className={window.dynamicHeight ? 'dynamic-height' : undefined}
    />
  );
}
