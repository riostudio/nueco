/**
 * Web-side wrapper for the table bridge (used only inside the custom WebView bundle - see
 * Tiptap.tsx). Imports `BridgeExtension` from "/web" instead of the package root, since the root
 * pulls in the whole React-Native-targeted bundle (Flow syntax, fails to parse under Vite). See
 * src/editor/tableBridgeConfig.ts's comment and src/editor/tableBridge.ts (the React-Native-side
 * counterpart, imported by app/editor.tsx) for the full explanation.
 */
import { BridgeExtension } from '@10play/tentap-editor/web';
import { tableBridgeConfig, type TableEditorState, type TableEditorInstance } from '../src/editor/tableBridgeConfig';

export const TableBridge = new BridgeExtension<TableEditorState, TableEditorInstance, any>(tableBridgeConfig);
