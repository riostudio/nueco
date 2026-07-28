/**
 * Shared bridge config for the table extension, factored out so both sides of the WebView
 * bridge can build a `BridgeExtension` from it while importing the `BridgeExtension` class from
 * their OWN correct path:
 *   - app/editor.tsx (React Native) needs `BridgeExtension` from the package root - see
 *     tableBridge.ts.
 *   - webEditor/Tiptap.tsx (the custom web bundle, built with Vite) needs it from the "/web"
 *     export instead - importing the root on that side pulls in the whole React-Native-targeted
 *     bundle, which fails to parse under Vite (it contains Flow syntax). See
 *     webEditor/tableBridgeWeb.ts.
 * TypeScript's `declare module 'X' { interface EditorBridge extends ... }` augmentation (in
 * tableBridge.ts) only merges against code that imported `BridgeExtension` from that exact same
 * specifier 'X', so the class itself can't be shared across both paths - only this config can.
 *
 * Deliberately a minimal, mobile-appropriate action set - @tiptap/extension-table also exposes
 * cell merge/split/header-toggle commands, but those need a multi-cell selection UI that doesn't
 * translate well to a phone-width toolbar; insert/add-row/add-column/delete-row/delete-column/
 * delete-table covers the actions a touch toolbar can expose as single taps.
 */
import { Table, TableRow, TableHeader, TableCell } from '@tiptap/extension-table';

export type TableEditorState = {
  isTableActive: boolean;
};

export type TableEditorInstance = {
  insertTable: () => void;
  addColumnAfter: () => void;
  addRowAfter: () => void;
  deleteColumn: () => void;
  deleteRow: () => void;
  deleteTable: () => void;
};

export enum TableEditorActionType {
  InsertTable = 'insert-table',
  AddColumnAfter = 'add-column-after',
  AddRowAfter = 'add-row-after',
  DeleteColumn = 'delete-column',
  DeleteRow = 'delete-row',
  DeleteTable = 'delete-table',
}

export type TableMessage = { type: TableEditorActionType; payload?: undefined };

export const tableBridgeConfig = {
  tiptapExtension: Table.configure({ resizable: false }),
  tiptapExtensionDeps: [TableRow, TableHeader, TableCell],
  onBridgeMessage: (editor: any, message: TableMessage) => {
    switch (message.type) {
      case TableEditorActionType.InsertTable:
        editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run();
        break;
      case TableEditorActionType.AddColumnAfter:
        editor.chain().focus().addColumnAfter().run();
        break;
      case TableEditorActionType.AddRowAfter:
        editor.chain().focus().addRowAfter().run();
        break;
      case TableEditorActionType.DeleteColumn:
        editor.chain().focus().deleteColumn().run();
        break;
      case TableEditorActionType.DeleteRow:
        editor.chain().focus().deleteRow().run();
        break;
      case TableEditorActionType.DeleteTable:
        editor.chain().focus().deleteTable().run();
        break;
    }
    return false;
  },
  extendEditorInstance: (sendBridgeMessage: (message: TableMessage) => void): TableEditorInstance => {
    return {
      insertTable: () => sendBridgeMessage({ type: TableEditorActionType.InsertTable }),
      addColumnAfter: () => sendBridgeMessage({ type: TableEditorActionType.AddColumnAfter }),
      addRowAfter: () => sendBridgeMessage({ type: TableEditorActionType.AddRowAfter }),
      deleteColumn: () => sendBridgeMessage({ type: TableEditorActionType.DeleteColumn }),
      deleteRow: () => sendBridgeMessage({ type: TableEditorActionType.DeleteRow }),
      deleteTable: () => sendBridgeMessage({ type: TableEditorActionType.DeleteTable }),
    };
  },
  extendEditorState: (editor: any): TableEditorState => {
    return {
      isTableActive: editor.isActive('table'),
    };
  },
  // The default Tiptap table CSS is desktop-oriented (fixed cell widths, resize handles) and
  // unusable untouched at phone width - this replaces it with a horizontally-scrollable,
  // touch-friendly rendering instead.
  extendCSS: `
  .tableWrapper {
    overflow-x: auto;
    margin: 0.5rem 0;
    -webkit-overflow-scrolling: touch;
  }

  table {
    border-collapse: collapse;
    table-layout: fixed;
    width: 100%;
    min-width: 100%;
  }

  table td, table th {
    min-width: 90px;
    border: 1.5px solid #E0E0E0;
    padding: 8px 10px;
    vertical-align: top;
    box-sizing: border-box;
    position: relative;
  }

  table th {
    font-weight: 700;
    text-align: left;
    background-color: #FAFAFA;
  }

  table p {
    margin: 0;
  }
  `,
};
