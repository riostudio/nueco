/**
 * React-Native-side wrapper for the content-height bridge (imported by app/editor.tsx) - imports
 * `BridgeExtension` from the package root, matching tableBridge.ts/wrappedImageBridge.ts. No
 * EditorBridge/BridgeState augmentation needed here - nothing on the native side ever calls into
 * this extension or reads state off it; see contentHeightConfig.ts's header for the full picture
 * and webEditor/contentHeightBridgeWeb.ts for the web-side counterpart.
 */
import { BridgeExtension } from '@10play/tentap-editor';
import { contentHeightBridgeConfig } from './contentHeightConfig';

export const ContentHeightBridge = new BridgeExtension<{}, {}, any>(contentHeightBridgeConfig);
