/**
 * Bridges an OS share (via expo-share-intent) into the note editor.
 *
 * Rendered once, under <ShareIntentProvider> in the root layout. On a fresh share it
 * normalizes the payload into a NoteDraft, stages it, and routes to /share-target so the user
 * can pick a new note or an existing one (both land on the editor pre-filled/appended, see
 * editor.tsx's two shared-draft effects). Handles cold-start, background, and foreground shares
 * (the hook fires for each). Renders nothing.
 */
import { useEffect, useRef } from 'react';
import { Platform, ToastAndroid, Alert } from 'react-native';
import { useRouter } from 'expo-router';
import { useShareIntentContext } from 'expo-share-intent';
import * as FileSystem from 'expo-file-system/legacy';
import * as VideoThumbnails from 'expo-video-thumbnails';
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
    // intent pending - it'll be picked up after auth (this effect re-runs on isAuthenticated).
    if (!isAuthenticated) return;

    busy.current = true;
    (async () => {
      try {
        // Files aren't uploaded here - they're staged as pendingFiles and the editor
        // uploads them with a visible radial progress.
        const draft = await normalizeShareIntent(shareIntent, {
          readBase64: (uri) => FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.Base64 }),
          // A shared video gets a poster frame for its card thumbnail (best-effort).
          videoThumbnail: async (uri) => {
            try {
              const { uri: thumbUri } = await VideoThumbnails.getThumbnailAsync(uri, { time: 1000 });
              const b64 = await FileSystem.readAsStringAsync(thumbUri, { encoding: FileSystem.EncodingType.Base64 });
              return `data:image/jpeg;base64,${b64}`;
            } catch {
              return undefined;
            }
          },
          onWarn: toast,
        });
        setPendingShareDraft(draft);
        // Let the user choose a new note vs. an existing one, instead of always creating new.
        router.push('/share-target');
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
