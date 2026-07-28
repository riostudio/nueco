/**
 * Web-side wrapper for the placeholder bridge (used only inside the custom WebView bundle - see
 * Tiptap.tsx). Imports `BridgeExtension` from "/web" - see tableBridgeWeb.ts's counterpart
 * comment and src/editor/placeholderBridgeConfig.ts for the full explanation.
 */
import { BridgeExtension } from '@10play/tentap-editor/web';
import { placeholderBridgeConfig } from '../src/editor/placeholderBridgeConfig';

export const NotePlaceholderBridge = new BridgeExtension<{}, {}, any>(placeholderBridgeConfig);
