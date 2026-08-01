/**
 * Web-side wrapper for the content-height bridge (used only inside the custom WebView bundle -
 * see Tiptap.tsx). Imports `BridgeExtension` from "/web" instead of the package root, since the
 * root pulls in the whole React-Native-targeted bundle (Flow syntax, fails to parse under Vite).
 * See src/editor/contentHeightConfig.ts's header comment and src/editor/contentHeightBridge.ts
 * (the React-Native-side counterpart) for the full explanation - same split
 * tableBridgeWeb.ts/tableBridge.ts already use.
 */
import { BridgeExtension } from '@10play/tentap-editor/web';
import { contentHeightBridgeConfig } from '../src/editor/contentHeightConfig';

export const ContentHeightBridge = new BridgeExtension<{}, {}, any>(contentHeightBridgeConfig);
