/**
 * React-Native-side wrapper for the wrapped-image bridge (imported by app/editor.tsx) - imports
 * `BridgeExtension` from the package root, which is what makes the `declare module` block below
 * merge into the `EditorBridge`/`BridgeState` types app/editor.tsx uses. See
 * wrappedImageConfig.ts's header and webEditor/wrappedImageBridgeWeb.ts for why the web-side
 * counterpart needs its own separate wrapper (same split as tableBridge.ts/tableBridgeWeb.ts).
 */
import { BridgeExtension } from '@10play/tentap-editor';
import { wrappedImageBridgeConfig, type WrappedImageEditorState, type WrappedImageEditorInstance } from './wrappedImageConfig';

declare module '@10play/tentap-editor' {
  interface BridgeState extends WrappedImageEditorState {}
  interface EditorBridge extends WrappedImageEditorInstance {}
}

export const WrappedImageBridge = new BridgeExtension<WrappedImageEditorState, WrappedImageEditorInstance, any>(wrappedImageBridgeConfig);
