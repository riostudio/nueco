/**
 * Bridges an OS share (via expo-share-intent) into the note editor.
 *
 * Rendered once, under <ShareIntentProvider> in the root layout. On a fresh share it
 * normalizes the payload into a NoteDraft, stages it, and routes to the editor pre-filled
 * (`/editor?shared=1`). Handles cold-start, background, and foreground shares (the hook
 * fires for each). Renders nothing.
 */
import { useEffect, useRef } from 'react';
import { Platform, ToastAndroid, Alert } from 'react-native';
import { useRouter } from 'expo-router';
import { useShareIntentContext } from 'expo-share-intent';
import * as FileSystem from 'expo-file-system/legacy';
import { uploadAttachment } from '../api';
import { useAuth } from '../auth';
import { normalizeShareIntent } from '../share/normalizeShareIntent';
import { setPendingShareDraft } from '../share/pendingShareDraft';

function toast(message: string): void {
  if (Platform.OS === 'android') ToastAndroid.show(message, ToastAndroid.SHORT);
  else Alert.alert('', message);
}

export function ShareIntentHandler() {
  const router = useRouter();
  const { hasShareIntent, shareIntent, resetShareIntent } = useShareIntentContext();
  const { isAuthenticated } = useAuth();
  const busy = useRef(false);

  useEffect(() => {
    if (!hasShareIntent || busy.current) return;
    // A share can only become a note once the user is signed in; if not, leave the
    // intent pending — it'll be picked up after auth (this effect re-runs on isAuthenticated).
    if (!isAuthenticated) return;

    busy.current = true;
    (async () => {
      try {
        const draft = await normalizeShareIntent(shareIntent, {
          readBase64: (uri) => FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.Base64 }),
          uploadFile: (f) => uploadAttachment(f),
          onWarn: toast,
        });
        setPendingShareDraft(draft);
        router.push('/editor?shared=1');
      } catch (e) {
        console.error('Share intent handling failed:', e);
        toast('Could not open the shared content.');
      } finally {
        resetShareIntent();
        busy.current = false;
      }
    })();
    // shareIntent is a fresh object per share; keying on hasShareIntent + auth is enough.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasShareIntent, isAuthenticated]);

  return null;
}
