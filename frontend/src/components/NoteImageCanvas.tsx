/**
 * The dedicated, onLayout-measured region free-floating image objects live in - wraps only the
 * note's shared-post-card + rich-text body (its children), NOT the title/tags/Attachments/old
 * inline-images gallery sections, which stay outside this component in normal scroll flow,
 * unchanged. This is a deliberate deviation from a literal "float over the whole note" reading
 * of the feature spec: the rich-text body's WebView has no real measured height today (only a
 * heuristic content-length estimate, see editor.tsx's bodyHeight), so anchoring objects to it
 * directly would mean object positions drift as that estimate's accuracy varies by content.
 * This canvas's own onLayout gives objects a real, stable coordinate space to live in instead.
 *
 * Only canvas WIDTH is used for the persisted normalized coordinates (see noteObjectsCore.ts) -
 * height is read live, purely for the drag-end "keep reachable" clamp, and is never baked into
 * stored data, so it staying unstable (it grows/shrinks as bodyHeight's estimate changes) is
 * harmless.
 */
import React, { useState } from 'react';
import { View, StyleSheet, LayoutChangeEvent } from 'react-native';
import { useSharedValue } from 'react-native-reanimated';
import type { NoteObject } from '../types';
import DraggableImageObject, { type ObjectTransformPatch } from './DraggableImageObject';

interface Props {
  objects: NoteObject[];
  selectedObjectId: string | null;
  onSelect: (id: string) => void;
  onGestureEnd: (id: string, patch: ObjectTransformPatch) => void;
  onRequestDelete: (id: string) => void;
  children: React.ReactNode;
}

export default function NoteImageCanvas({ objects, selectedObjectId, onSelect, onGestureEnd, onRequestDelete, children }: Props) {
  const [canvasWidth, setCanvasWidth] = useState(0);
  const canvasWidthSV = useSharedValue(0);
  const canvasHeightSV = useSharedValue(0);

  const handleLayout = (e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    setCanvasWidth(width);
    canvasWidthSV.value = width;
    canvasHeightSV.value = height;
  };

  return (
    <View style={s.region} onLayout={handleLayout}>
      {children}
      {/* box-none: touches pass through to the text/card content below wherever no object sits -
          each DraggableImageObject still receives its own gesture independently. */}
      <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
        {objects
          .slice()
          .sort((a, b) => a.z - b.z)
          .map((o) => (
            <DraggableImageObject
              key={o.id}
              object={o}
              canvasWidth={canvasWidth}
              canvasWidthSV={canvasWidthSV}
              canvasHeightSV={canvasHeightSV}
              selected={o.id === selectedObjectId}
              onSelect={onSelect}
              onGestureEnd={onGestureEnd}
              onRequestDelete={onRequestDelete}
            />
          ))}
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  region: {
    position: 'relative',
  },
});
