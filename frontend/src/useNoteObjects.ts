/**
 * State + actions for a note's free-floating image objects - kept in its own hook rather than
 * inline in editor.tsx (already ~2800 lines) so this feature's logic is independently readable.
 *
 * Phase 1 scope (see /Users/riobudiman/.claude/plans/fuzzy-orbiting-clover.md): `addImages` here
 * picks directly via expo-image-picker (allowsEditing: false, satisfying the "never crop"
 * requirement from day one) and uses the picker's own asset URI as `local_uri`. It does NOT yet
 * run the EXIF-normalization/downscale/permanent-file-copy pipeline (noteImagePicker.ts) or
 * queue an S3 upload (noteObjectsSync.ts) - both are Phase 2. This lets drag/pinch/rotate and
 * the persistLocal round-trip be validated end-to-end first, on a real device, before the
 * upload pipeline (the larger, riskier remaining piece) is layered on. Swapping the picker
 * implementation later doesn't change this hook's external interface.
 */
import { useState, useRef, useEffect, useCallback, type RefObject } from 'react';
import * as ImagePicker from 'expo-image-picker';
import { Alert } from 'react-native';
import uuid from 'react-native-uuid';
import type { NoteObject } from './types';
import { nextZIndex, clampScale } from './noteObjectsCore';
import type { ObjectTransformPatch } from './components/DraggableImageObject';
import { trackNoteImageAttached } from './analytics/posthog';

export function useNoteObjects(noteIdRef: RefObject<string>, saveImmediately: () => void) {
  const [objects, setObjects] = useState<NoteObject[]>([]);
  const objectsRef = useRef<NoteObject[]>([]);
  const [selectedObjectId, setSelectedObjectId] = useState<string | null>(null);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);

  useEffect(() => { objectsRef.current = objects; }, [objects]);

  // Called once after loading/creating the note (editor.tsx seeds this the same way it seeds
  // imagesRef/attachmentsRef from a loaded note or a shared draft).
  const seedObjects = useCallback((loaded: NoteObject[]) => {
    objectsRef.current = loaded;
    setObjects(loaded);
  }, []);

  const addImages = useCallback(async (kind: 'camera' | 'gallery') => {
    const permission = kind === 'camera'
      ? await ImagePicker.requestCameraPermissionsAsync()
      : await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (permission.status !== 'granted') {
      Alert.alert('Permission Needed', kind === 'camera'
        ? 'Camera access is required to take photos.'
        : 'Gallery access is required to select photos.');
      return;
    }

    // allowsEditing: false, no aspect lock - never crop/alter aspect ratio, per spec.
    const result = kind === 'camera'
      ? await ImagePicker.launchCameraAsync({ mediaTypes: ['images'], allowsEditing: false, quality: 1 })
      : await ImagePicker.launchImageLibraryAsync({
          mediaTypes: ['images'], allowsEditing: false, quality: 1,
          allowsMultipleSelection: true, selectionLimit: 5,
        });
    if (result.canceled || result.assets.length === 0) return;

    const base = nextZIndex(objectsRef.current);
    const newObjects: NoteObject[] = result.assets
      .filter((a) => a.width && a.height)
      .map((a, i) => ({
        id: uuid.v4() as string,
        type: 'image',
        local_uri: a.uri,
        remote_url: null,
        key: null,
        intrinsic_width: a.width,
        intrinsic_height: a.height,
        // Stagger multi-select adds slightly so they don't land exactly on top of each other.
        x: 0.5 + i * 0.03,
        y: 0.4 + i * 0.03,
        scale: 1,
        rotation: 0,
        z: base + i,
        upload_status: 'pending',
      }));
    if (newObjects.length === 0) return;

    const next = [...objectsRef.current, ...newObjects];
    objectsRef.current = next;
    setObjects(next);
    setSelectedObjectId(newObjects[newObjects.length - 1].id);
    trackNoteImageAttached(next.length);
    saveImmediately();
  }, [saveImmediately]);


  const selectObject = useCallback((id: string) => {
    setSelectedObjectId(id);
    // Bring to front on select, per spec.
    const current = objectsRef.current;
    const idx = current.findIndex((o) => o.id === id);
    if (idx === -1) return;
    const maxZ = nextZIndex(current) - 1;
    if (current[idx].z === maxZ && idx === current.length - 1) return; // already frontmost, no-op
    const bumped = current.map((o) => (o.id === id ? { ...o, z: nextZIndex(current) } : o));
    objectsRef.current = bumped;
    setObjects(bumped);
  }, []);

  const deselectAll = useCallback(() => setSelectedObjectId(null), []);

  const commitTransform = useCallback((id: string, patch: ObjectTransformPatch) => {
    const next = objectsRef.current.map((o) =>
      o.id === id ? { ...o, x: patch.x, y: patch.y, scale: clampScale(patch.scale), rotation: patch.rotation } : o
    );
    objectsRef.current = next;
    setObjects(next);
    saveImmediately();
  }, [saveImmediately]);

  const requestDelete = useCallback((id: string) => setPendingDeleteId(id), []);
  const cancelDelete = useCallback(() => setPendingDeleteId(null), []);

  const confirmDelete = useCallback(() => {
    if (!pendingDeleteId) return;
    const next = objectsRef.current.filter((o) => o.id !== pendingDeleteId);
    objectsRef.current = next;
    setObjects(next);
    if (selectedObjectId === pendingDeleteId) setSelectedObjectId(null);
    setPendingDeleteId(null);
    saveImmediately();
    // S3/local-file/upload-queue cleanup for a real uploaded object is Phase 2/3 - see the plan.
  }, [pendingDeleteId, selectedObjectId, saveImmediately]);

  return {
    objects, objectsRef, selectedObjectId, pendingDeleteId,
    seedObjects, addImages, selectObject, deselectAll, commitTransform, requestDelete, confirmDelete, cancelDelete,
  };
}
