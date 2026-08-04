/**
 * Shared bridge config for a text-wrapped, resizable image node - a genuinely different
 * mechanism from the free-floating drag/pinch/rotate objects in noteObjectsCore.ts/
 * DraggableImageObject.tsx/useNoteObjects.ts. Those stay in the codebase (tested, working) but
 * are no longer wired to the "Take Photo"/"Choose from Gallery" buttons - real CSS text-wrap and
 * free rotation are mutually exclusive (browsers reflow text around an axis-aligned box, never a
 * rotated one), and the user chose wrap over free transform after seeing both explained.
 *
 * This node lives in the note's `content` HTML (like a sketch's inline <img>, see
 * NoteBodyEditor's insertImage), NOT the separate `objects[]` array - no position/rotation to
 * persist, just src/width/align, all serialized as ordinary node attributes.
 *
 * Same native/web split as tableBridgeConfig.ts (see that file's own comment for exactly why):
 * this file has no BridgeExtension import at all, just the plain TipTap Node + bridge glue -
 * wrappedImageBridge.ts (native) and webEditor/wrappedImageBridgeWeb.ts (web) each wrap this with
 * `BridgeExtension` imported from their own correct path.
 *
 * Resize handle: a hand-rolled NodeView with vanilla-JS pointer-event drag (no precedent for a
 * custom interactive NodeView anywhere else in this codebase - tableBridgeConfig.ts explicitly
 * disabled Tiptap's own built-in table resize instead of adapting it for touch, "unusable
 * untouched at phone width"). This needed writing from scratch rather than adapting something
 * proven, and hasn't been run on a real device - flag this clearly when reporting status; it's
 * the highest-uncertainty piece of this feature, more so than the native gesture code was.
 */
import { Node, mergeAttributes } from '@tiptap/core';

// 'full' is a third, non-floating mode used only when an image is the very first thing inserted
// into an empty note (see onBridgeMessage below) - fills the note's full width, block-level (no
// wrap), so the very next line starts cleanly below it rather than beside it.
export type WrapAlign = 'left' | 'right' | 'full';

export const MIN_WRAP_WIDTH = 60;
export const MAX_WRAP_WIDTH = 600;
export const DEFAULT_WRAP_WIDTH = 160;
// Visual breathing room between the image and the text wrapping around it - the same 25px asked
// for on the free-floating object's padding halo, applied here as real CSS margin (margin, not
// padding, is what actually pushes wrapped text away from a floated element's box).
export const WRAP_MARGIN_PX = 25;

export type WrappedImageEditorState = {};

export type WrappedImageEditorInstance = {
  // naturalWidth/Height seed the node's initial display width (capped to MAX_WRAP_WIDTH) while
  // preserving aspect ratio - the resize handle only ever adjusts `width`; height always follows
  // from the image's own intrinsic ratio (img style="height:auto"), so it can't be skewed.
  insertWrappedImage: (src: string, naturalWidth: number, naturalHeight: number) => void;
};

export enum WrappedImageActionType {
  Insert = 'insert-wrapped-image',
}

export type WrappedImageMessage = {
  type: WrappedImageActionType.Insert;
  payload: { src: string; width: number; align: WrapAlign };
};

// The interactive node itself - shared between the native-side declare-module augmentation
// (wrappedImageBridge.ts) and the web-side NodeView (rendered inside the WebView bundle). Kept
// in this shared file (not duplicated) since the NodeView is pure DOM/JS with no platform-specific
// import, unlike BridgeExtension itself (see this file's header comment on why that one splits).
export const WrappedImageNode = Node.create({
  name: 'wrappedImage',
  group: 'inline',
  inline: true,
  atom: true,
  draggable: true,

  addAttributes() {
    return {
      src: { default: null },
      width: { default: DEFAULT_WRAP_WIDTH },
      align: { default: 'left' as WrapAlign },
    };
  },

  parseHTML() {
    // Explicit getAttrs rather than relying on Tiptap's default per-attribute HTML round-trip -
    // `width`'s schema default is a number, but any value read off the DOM via getAttribute() is
    // always a string, and leaving that coercion implicit is the kind of thing that quietly
    // breaks (a node re-parsed from saved `content` HTML looking "resized"/reverted) without ever
    // throwing an error to notice it by.
    //
    // priority: the stock ImageBridge (@tiptap/extension-image, part of TenTapStartKit - see
    // app/editor.tsx's noteBridgeExtensions) registers its own catch-all `img[src]` parse rule,
    // which also matches this node's rendered <img data-wrapped-image src=... > tag. Both rules
    // default to ProseMirror's standard priority (50), so ties are broken by extension
    // registration order - and the stock ImageBridge is listed before WrappedImageBridge, so its
    // generic rule silently won on every reload, downgrading wrappedImage nodes to plain `image`
    // nodes (dropping `align` entirely, since stock Image has no such attribute, and falling back
    // to `width`-as-fixed-pixels instead of the wrap/full-width CSS) - exactly the "image looks
    // resized after reopening the note" bug. A higher priority makes this more-specific selector
    // win regardless of registration order.
    return [{
      tag: 'img[data-wrapped-image]',
      priority: 100,
      getAttrs: (el: HTMLElement) => {
        const parsedWidth = parseInt(el.getAttribute('width') || '', 10);
        const align = el.getAttribute('align');
        return {
          src: el.getAttribute('src'),
          width: Number.isFinite(parsedWidth) && parsedWidth > 0 ? parsedWidth : DEFAULT_WRAP_WIDTH,
          align: align === 'left' || align === 'right' || align === 'full' ? align : 'left',
        };
      },
    }];
  },

  renderHTML({ HTMLAttributes }) {
    // Static (non-interactive) HTML representation - used for serialization/SSR-ish paths;
    // addNodeView below takes over for the actual editable rendering.
    const isFull = HTMLAttributes.align === 'full';
    const style = isFull
      ? `width:100%;height:auto;display:block;float:none;clear:both;margin:0 0 ${WRAP_MARGIN_PX}px 0;border-radius:8px;`
      : `width:${HTMLAttributes.width}px;height:auto;float:${HTMLAttributes.align};clear:both;margin:${
          HTMLAttributes.align === 'right' ? `0 0 ${WRAP_MARGIN_PX}px ${WRAP_MARGIN_PX}px` : `0 ${WRAP_MARGIN_PX}px ${WRAP_MARGIN_PX}px 0`
        };border-radius:8px;`;
    return [
      'img',
      mergeAttributes(HTMLAttributes, {
        'data-wrapped-image': 'true',
        src: HTMLAttributes.src,
        style,
      }),
    ];
  },

  addNodeView() {
    return ({ node, editor, getPos }) => {
      const wrapper = document.createElement('span');
      wrapper.setAttribute('data-wrapped-image-wrapper', 'true');
      wrapper.contentEditable = 'false';
      wrapper.style.display = 'inline-block';
      wrapper.style.position = 'relative';
      wrapper.style.lineHeight = '0'; // avoid a stray inline-baseline gap under the image

      const applyWrapperStyle = (align: WrapAlign, width: number) => {
        if (align === 'full') {
          // Block, no float - the very first image in an empty note fills the writing area's
          // width and pushes whatever's typed next onto its own line below, rather than beside it.
          wrapper.style.float = 'none';
          wrapper.style.display = 'block';
          wrapper.style.width = '100%';
          wrapper.style.margin = `0 0 ${WRAP_MARGIN_PX}px 0`;
          img.style.width = '100%';
        } else {
          wrapper.style.float = align;
          wrapper.style.display = 'inline-block';
          wrapper.style.width = '';
          wrapper.style.margin = align === 'right'
            ? `0 0 ${WRAP_MARGIN_PX}px ${WRAP_MARGIN_PX}px`
            : `0 ${WRAP_MARGIN_PX}px ${WRAP_MARGIN_PX}px 0`;
          img.style.width = `${width}px`;
        }
        // Without this, a float doesn't necessarily start on its own line - if the paragraph
        // before it (e.g. existing note text) has room left on its last line, the float tucks in
        // right alongside it instead of dropping below, which is exactly the "text still wraps
        // around a freshly-added image" bug wrappedImageConfig.ts's insertion logic (see
        // onBridgeMessage below) otherwise can't prevent on its own. Harmless (a no-op) on the
        // 'full' branch, which is never floated in the first place.
        wrapper.style.clear = 'both';
      };

      const img = document.createElement('img');
      img.src = node.attrs.src;
      img.style.display = 'block';
      img.style.height = 'auto';
      img.style.borderRadius = '8px';
      img.draggable = false;
      wrapper.appendChild(img);
      applyWrapperStyle(node.attrs.align, node.attrs.width);

      const handle = document.createElement('span');
      handle.setAttribute('data-wrapped-image-handle', 'true');
      Object.assign(handle.style, {
        position: 'absolute',
        right: '-8px',
        bottom: '-8px',
        width: '22px',
        height: '22px',
        borderRadius: '11px',
        background: '#FFFFFF',
        border: '2px solid #0A5443',
        touchAction: 'none', // stop the WebView's own scroll/pan from stealing this drag
        display: 'none', // shown only while selected, via the selectNode/deselectNode below
      } as CSSStyleDeclaration);
      wrapper.appendChild(handle);

      let startClientX = 0;
      let startWidth = node.attrs.width;

      const commitWidth = (width: number) => {
        const pos = typeof getPos === 'function' ? getPos() : null;
        if (typeof pos !== 'number') return;
        // Dragging a 'full' (100%, non-floating) image to a specific pixel width only makes
        // sense as "convert it into a normal wrap image at that size" - leaving align:'full'
        // would have applyWrapperStyle's update() snap it straight back to 100% regardless.
        const align = node.attrs.align === 'full' ? 'left' : node.attrs.align;
        const tr = editor.view.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, width, align });
        editor.view.dispatch(tr);
      };

      const onPointerMove = (e: PointerEvent) => {
        const dx = e.clientX - startClientX;
        const next = Math.max(MIN_WRAP_WIDTH, Math.min(MAX_WRAP_WIDTH, startWidth + dx));
        img.style.width = `${next}px`;
      };
      const onPointerUp = (e: PointerEvent) => {
        document.removeEventListener('pointermove', onPointerMove);
        document.removeEventListener('pointerup', onPointerUp);
        const finalWidth = Math.round(parseFloat(img.style.width) || node.attrs.width);
        commitWidth(finalWidth);
      };
      handle.addEventListener('pointerdown', (e: PointerEvent) => {
        e.preventDefault();
        e.stopPropagation();
        startClientX = e.clientX;
        // getBoundingClientRect (not parseFloat(img.style.width)) so this starts from the real
        // rendered pixel width even when it's currently CSS '100%' (the 'full' align mode).
        startWidth = img.getBoundingClientRect().width || node.attrs.width;
        document.addEventListener('pointermove', onPointerMove);
        document.addEventListener('pointerup', onPointerUp);
      });

      return {
        dom: wrapper,
        update(updatedNode) {
          if (updatedNode.type.name !== 'wrappedImage') return false;
          img.src = updatedNode.attrs.src;
          applyWrapperStyle(updatedNode.attrs.align, updatedNode.attrs.width);
          return true;
        },
        selectNode() {
          handle.style.display = 'block';
        },
        deselectNode() {
          handle.style.display = 'none';
        },
        stopEvent(e: Event) {
          // Let the handle's own pointer events through without ProseMirror intercepting them
          // as a selection/drag gesture on the node itself.
          return e.target === handle;
        },
      };
    };
  },
});

// Bridge glue - mirrors tableBridgeConfig.ts's shape exactly (onBridgeMessage/
// extendEditorInstance/extendEditorState/extendCSS), so the native (wrappedImageBridge.ts) and
// web (webEditor/wrappedImageBridgeWeb.ts) wrappers only differ in which path they import
// BridgeExtension from.
export const wrappedImageBridgeConfig = {
  tiptapExtension: WrappedImageNode,
  onBridgeMessage: (editor: any, message: WrappedImageMessage) => {
    if (message.type === WrappedImageActionType.Insert) {
      // Every freshly-inserted image defaults to 'full' (block, 100% width) rather than a small
      // floated column with text wrapping beside it - message.payload.align (still sent as
      // 'left' by insertWrappedImage) is intentionally ignored here. Dragging the resize handle
      // afterwards still converts an image out of 'full' into a normal floating wrap image at
      // that pixel width (see commitWidth in WrappedImageNode's addNodeView above) - full-width
      // is just the default, not the only option.
      const imageNode = {
        type: 'wrappedImage',
        attrs: { src: message.payload.src, width: message.payload.width, align: 'full' },
      };
      // Splicing the image in at whatever the cursor's current position happens to be (the old
      // behavior) made an image dropped into an already-written note look like it was wrapping
      // around existing text mid-paragraph, when the user just wanted a photo added below what
      // they'd written. So: append the image as its own new paragraph at the end of the
      // document, regardless of where the cursor currently sits, UNLESS the note is empty.
      if (editor.isEmpty) {
        // The trailing empty paragraph guarantees the cursor lands on a fresh line below the
        // image, not inline right after it, in case the block-level image CSS alone doesn't
        // force ProseMirror's own selection to move past it the same way the browser renders it.
        editor
          .chain()
          .setContent({ type: 'doc', content: [{ type: 'paragraph', content: [imageNode] }, { type: 'paragraph' }] })
          .focus('end')
          .run();
      } else {
        editor.chain().focus('end').insertContent([{ type: 'paragraph', content: [imageNode] }]).run();
      }
    }
    return false;
  },
  extendEditorInstance: (sendBridgeMessage: (message: WrappedImageMessage) => void): WrappedImageEditorInstance => {
    return {
      insertWrappedImage: (src: string, naturalWidth: number, naturalHeight: number) => {
        // Seed at intrinsic size (capped) so a small photo doesn't get stretched up to
        // MAX_WRAP_WIDTH, and a huge one starts at a sane reading width, not its full pixel size.
        const width = naturalWidth > 0 ? Math.max(MIN_WRAP_WIDTH, Math.min(naturalWidth, DEFAULT_WRAP_WIDTH * 1.5)) : DEFAULT_WRAP_WIDTH;
        void naturalHeight; // height always follows the image's own aspect ratio (style="height:auto"), never stored
        sendBridgeMessage({ type: WrappedImageActionType.Insert, payload: { src, width, align: 'left' } });
      },
    };
  },
  extendEditorState: (): WrappedImageEditorState => ({}),
  extendCSS: `
  span[data-wrapped-image-wrapper] {
    max-width: 100%;
  }
  span[data-wrapped-image-wrapper] img {
    max-width: 100%;
  }
  `,
};
