import React from 'react';
import { createRoot } from 'react-dom/client';
import Tiptap from './Tiptap';

declare global {
  interface Window {
    contentInjected: boolean | undefined;
  }
}

/**
 * On android - react-native-webview there is a bug where sometimes the content is injected
 * after the window is loaded https://github.com/react-native-webview/react-native-webview/pull/2960
 * To overcome this we wait until content is injected before rendering the editor - mirrors
 * @10play/tentap-editor's own simpleWebEditor/index.tsx exactly.
 */
const contentInjected = () => window.contentInjected;
let interval: ReturnType<typeof setInterval>;
interval = setInterval(() => {
  if (!contentInjected()) return;
  const container = document.getElementById('root');
  const root = createRoot(container!);
  root.render(<Tiptap />);
  clearInterval(interval);
  return;
}, 1);
