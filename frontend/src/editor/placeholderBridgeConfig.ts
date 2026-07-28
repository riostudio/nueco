/**
 * Shared config for a placeholder that only ever shows on the pristine "nothing typed yet"
 * paragraph - not on every empty node the cursor happens to sit in.
 *
 * The stock PlaceholderBridge (from @10play/tentap-editor's TenTapStartKit) uses Tiptap's
 * default `showOnlyCurrent: true` behavior, which shows the placeholder text on whatever node
 * currently holds the selection, as long as that node is empty - node TYPE doesn't matter. That
 * means toggling the checklist button on a blank note moves the cursor into a new, empty
 * `taskItem` paragraph, which is *also* empty, so the exact same "What do you have in mind" ghost
 * text renders overlapping the checkbox row. A plain string can't fix this - only a placeholder
 * *function* that checks the node type can, and per Tiptap's docs this is the standard fix
 * ("placeholder per node type").
 *
 * Split the same way as tableBridgeConfig.ts: this file is shared, but the `BridgeExtension`
 * class has to be imported from a different path depending on which side consumes it (see
 * placeholderBridge.ts for React Native, webEditor/placeholderBridgeWeb.ts for the web bundle).
 */
import { Placeholder } from '@tiptap/extensions';

export const PLACEHOLDER_TEXT = 'What do you have in mind';

export const placeholderBridgeConfig = {
  tiptapExtension: Placeholder.configure({
    placeholder: ({ node, editor }: { node: { type: { name: string } }; editor: { isEmpty: boolean } }) =>
      node.type.name === 'paragraph' && editor.isEmpty ? PLACEHOLDER_TEXT : '',
  }),
  extendCSS: `
    .is-editor-empty:first-child::before {
        color: #adb5bd;
        content: attr(data-placeholder);
        float: left;
        height: 0;
        pointer-events: none;
    }
  `,
};
