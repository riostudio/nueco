/**
 * Custom TenTap bridge for tables. No table bridge ships with @10play/tentap-editor (checked
 * every file in node_modules/@10play/tentap-editor/src/bridges/ - only tasklist.ts exists for
 * list-shaped content), so this is written from scratch, modeled directly on that file's
 * BridgeExtension shape.
 *
 * This is the React-Native-side wrapper (imported by app/editor.tsx) - it imports
 * `BridgeExtension` from the package root, which is what makes the `declare module` block below
 * actually merge into the `EditorBridge`/`BridgeState` types app/editor.tsx uses. The web-side
 * counterpart (webEditor/tableBridgeWeb.ts, used inside the custom WebView bundle) shares the
 * same tableBridgeConfig.ts but imports `BridgeExtension` from "/web" instead - see that config
 * file's comment for why the two can't share this one wrapper.
 */
import { BridgeExtension } from '@10play/tentap-editor';
import { tableBridgeConfig, type TableEditorState, type TableEditorInstance } from './tableBridgeConfig';

declare module '@10play/tentap-editor' {
  interface BridgeState extends TableEditorState {}
  interface EditorBridge extends TableEditorInstance {}
}

export const TableBridge = new BridgeExtension<TableEditorState, TableEditorInstance, any>(tableBridgeConfig);
