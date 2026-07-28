/**
 * React-Native-side wrapper (imported by app/editor.tsx) - see placeholderBridgeConfig.ts for
 * why this needs a smarter placeholder than the stock PlaceholderBridge, and
 * webEditor/placeholderBridgeWeb.ts for the web-side counterpart.
 *
 * No `.configureExtension()` call here (unlike the old `PlaceholderBridge.configureExtension({
 * placeholder: '...' })` this replaces) - the placeholder function is already baked into
 * placeholderBridgeConfig's tiptapExtension, and native-side config can only cross the
 * WebView bridge as JSON (see RichText/utils.ts's getInjectedJSBeforeContentLoad), which would
 * silently drop a function and overwrite it with a plain string again.
 */
import { BridgeExtension } from '@10play/tentap-editor';
import { placeholderBridgeConfig } from './placeholderBridgeConfig';

export const NotePlaceholderBridge = new BridgeExtension<{}, {}, any>(placeholderBridgeConfig);
