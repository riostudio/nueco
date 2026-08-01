/**
 * A single free-floating image object inside NoteImageCanvas.tsx - drag, pinch-scale, and
 * two-finger rotate composed via Gesture.Simultaneous, exactly like sketch.tsx's existing
 * pinch+pan precedent, extended with Gesture.Rotation - the first use of rotation gesture in
 * this codebase. All three gestures drive useSharedValue transforms only (UI thread, never
 * React state mid-gesture); a single `commit` call on gesture end converts back to normalized
 * coordinates and persists once - see noteObjectsCore.ts for the conversion/clamp math.
 *
 * Also renders four corner handles (visible when selected) for single-finger proportional
 * resize - the same uniform `scale` pinch already drives, just reachable without a two-finger
 * gesture. See scaleFromCornerDrag in noteObjectsCore.ts for the rotation-aware drag math.
 *
 * NOTE: like sketch.tsx (this app's only other custom gesture code), this cannot be exercised
 * in the sandboxed environment it was written in - no device/simulator with the native
 * gesture-handler/reanimated modules available. Type-checks cleanly but needs a dedicated
 * manual pass on real hardware, particularly the pan+pinch+rotate handoff, rotation feel, and
 * the corner-handle resize (untested against a real touch's jitter/precision).
 *
 * Positioning model: `object.x`/`object.y` (normalized 0..1, relative to canvas width) are the
 * object's CENTER point, not its top-left corner - this view's untransformed layout box is
 * centered on the canvas origin (negative half-size margins) so that `translateX`/`translateY`
 * map directly to that center point, and RN's default transform-origin (a view's own center)
 * makes rotate/scale pivot naturally around it without any extra math.
 *
 * Text wrap: there is deliberately no attempt here to make the note's text reflow around this
 * image. The text lives inside NoteBodyEditor's WebView (a separate rendering engine, ProseMirror/
 * HTML); this object is a native RN view layered on top of it via NoteImageCanvas's absolute-fill
 * overlay (see that file's own comment on why the canvas is a fixed region rather than tracking
 * the WebView's real layout). Native RN has no way to tell the WebView's internal text layout to
 * leave a hole for this image - true CSS-style wrap would require re-implementing the image as an
 * actual floated HTML element inside the WebView's document instead, which would mean losing
 * native drag/pinch/rotate (WebView content doesn't support those without a large custom
 * bridge/JS-injection effort) - the opposite of what this feature exists for. What IS implemented
 * instead: a 25px padded background halo around the image (PADDING below), so it doesn't visually
 * abut/overlap text pixel-for-pixel even though the text itself doesn't move out of the way.
 */
import React, { useEffect, useMemo } from 'react';
import { View, Image, StyleSheet, TouchableOpacity } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { useSharedValue, useAnimatedStyle, runOnJS, type SharedValue } from 'react-native-reanimated';
import type { NoteObject } from '../types';
import { toPixels, toNormalized, displayDimensions, clampScale, clampCenterToCanvas, scaleFromCornerDrag } from '../noteObjectsCore';
import { C, radius } from '../theme';

export interface ObjectTransformPatch {
  x: number;
  y: number;
  scale: number;
  rotation: number;
}

interface Props {
  object: NoteObject;
  canvasWidth: number; // plain number, used to seed/re-seed layout on canvas resize
  canvasWidthSV: SharedValue<number>;
  canvasHeightSV: SharedValue<number>;
  selected: boolean;
  onSelect: (id: string) => void;
  onGestureEnd: (id: string, patch: ObjectTransformPatch) => void;
  onRequestDelete: (id: string) => void;
}

// Visual breathing room around the image (see file header re: this being cosmetic, not true text
// wrap). Included in the box's own layout size, so the drag/pinch/rotate hit area covers it too.
const PADDING = 25;

// Outward-facing unit diagonal for each corner, screen coordinates (Y down) - matches
// noteObjectsCore.test.ts's own copies of these constants.
const CORNER_DIRECTIONS = {
  topLeft: { x: -Math.SQRT1_2, y: -Math.SQRT1_2 },
  topRight: { x: Math.SQRT1_2, y: -Math.SQRT1_2 },
  bottomLeft: { x: -Math.SQRT1_2, y: Math.SQRT1_2 },
  bottomRight: { x: Math.SQRT1_2, y: Math.SQRT1_2 },
} as const;
type CornerName = keyof typeof CORNER_DIRECTIONS;

export default function DraggableImageObject({
  object, canvasWidth, canvasWidthSV, canvasHeightSV, selected, onSelect, onGestureEnd, onRequestDelete,
}: Props) {
  // Layout box size at the "base" scale (1x) - fixed once per canvasWidth/intrinsic-size change,
  // never animated. The pinch gesture's visible scaling comes entirely from the `scale` transform
  // below, not from resizing this box, so a pinch never triggers a layout pass mid-gesture.
  const { width: imageW, height: imageH } = useMemo(
    () => displayDimensions(object.intrinsic_width, object.intrinsic_height, canvasWidth, 1),
    [object.intrinsic_width, object.intrinsic_height, canvasWidth]
  );
  const boxW = imageW + PADDING * 2;
  const boxH = imageH + PADDING * 2;

  const translateX = useSharedValue(0);
  const translateY = useSharedValue(0);
  const savedTranslateX = useSharedValue(0);
  const savedTranslateY = useSharedValue(0);
  const scale = useSharedValue(1);
  const savedScale = useSharedValue(1);
  const rotation = useSharedValue(0);
  const savedRotation = useSharedValue(0);

  // Seed (and re-seed on canvas resize, e.g. device rotation) from the stored normalized
  // position - see the file header for why x/y map directly to translateX/Y (center-based box).
  useEffect(() => {
    if (!canvasWidth) return;
    const center = toPixels(object.x, object.y, canvasWidth);
    translateX.value = center.x;
    translateY.value = center.y;
    savedTranslateX.value = center.x;
    savedTranslateY.value = center.y;
    scale.value = clampScale(object.scale);
    savedScale.value = scale.value;
    rotation.value = object.rotation;
    savedRotation.value = object.rotation;
    // Deliberately excludes the *current* gesture-driven shared values from deps - this effect
    // should only re-seed when the object's *persisted* fields or the canvas size change, not
    // re-run because a gesture just wrote a new translateX.value itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [object.id, object.x, object.y, object.scale, object.rotation, canvasWidth]);

  const select = () => onSelect(object.id);

  // Called once per gesture (from whichever of pan/pinch/rotate/corner-resize's onEnd fires),
  // reading the current shared-value state and persisting it - "on gesture end, not per-frame".
  const commit = () => {
    const canvasW = canvasWidthSV.value;
    const canvasH = canvasHeightSV.value;
    const clamped = clampCenterToCanvas(translateX.value, translateY.value, boxW * scale.value, boxH * scale.value, canvasW, canvasH);
    translateX.value = clamped.x;
    translateY.value = clamped.y;
    savedTranslateX.value = clamped.x;
    savedTranslateY.value = clamped.y;
    const norm = toNormalized(clamped.x, clamped.y, canvasW);
    onGestureEnd(object.id, { x: norm.x, y: norm.y, scale: scale.value, rotation: rotation.value });
  };

  const pan = Gesture.Pan()
    .onBegin(() => {
      'worklet';
      runOnJS(select)();
    })
    .onUpdate((e) => {
      'worklet';
      translateX.value = savedTranslateX.value + e.translationX;
      translateY.value = savedTranslateY.value + e.translationY;
    })
    .onEnd(() => {
      'worklet';
      runOnJS(commit)();
    });

  const pinch = Gesture.Pinch()
    .onBegin(() => {
      'worklet';
      runOnJS(select)();
    })
    .onUpdate((e) => {
      'worklet';
      scale.value = clampScale(savedScale.value * e.scale);
    })
    .onEnd(() => {
      'worklet';
      savedScale.value = scale.value;
      runOnJS(commit)();
    });

  const rotate = Gesture.Rotation()
    .onBegin(() => {
      'worklet';
      runOnJS(select)();
    })
    .onUpdate((e) => {
      'worklet';
      rotation.value = savedRotation.value + e.rotation;
    })
    .onEnd(() => {
      'worklet';
      savedRotation.value = rotation.value;
      runOnJS(commit)();
    });

  // Mandated by the spec: all three must work simultaneously, not as separate modes.
  const composed = Gesture.Simultaneous(pan, pinch, rotate);

  // One single-finger resize gesture per corner - proportional (uniform) scale, same as pinch,
  // just reachable by dragging a specific handle instead of a two-finger gesture.
  const makeCornerResize = (corner: CornerName) => {
    const dir = CORNER_DIRECTIONS[corner];
    return Gesture.Pan()
      .onUpdate((e) => {
        'worklet';
        scale.value = scaleFromCornerDrag(e.translationX, e.translationY, rotation.value, dir.x, dir.y, boxW, boxH, savedScale.value);
      })
      .onEnd(() => {
        'worklet';
        savedScale.value = scale.value;
        runOnJS(commit)();
      });
  };
  const resizeTopLeft = makeCornerResize('topLeft');
  const resizeTopRight = makeCornerResize('topRight');
  const resizeBottomLeft = makeCornerResize('bottomLeft');
  const resizeBottomRight = makeCornerResize('bottomRight');

  const animatedStyle = useAnimatedStyle(() => ({
    position: 'absolute',
    left: 0,
    top: 0,
    width: boxW,
    height: boxH,
    marginLeft: -boxW / 2,
    marginTop: -boxH / 2,
    // Transform order per spec: translate, rotate, scale.
    transform: [
      { translateX: translateX.value },
      { translateY: translateY.value },
      { rotateZ: `${rotation.value}rad` },
      { scale: scale.value },
    ],
  }));

  const displayUri = object.local_uri ?? object.remote_url ?? undefined;

  return (
    <GestureDetector gesture={composed}>
      <Animated.View style={animatedStyle}>
        {/* Padding halo - visual breathing room only, see file header re: this not being true
            text wrap. Sits behind the image, filling the full padded box. */}
        <View style={[StyleSheet.absoluteFill, s.paddingHalo]} />
        <View style={[s.imageInset, { width: imageW, height: imageH }]}>
          {displayUri ? (
            <Image source={{ uri: displayUri }} style={StyleSheet.absoluteFill} resizeMode="contain" />
          ) : (
            // No local file yet and nothing to fetch from (Phase 1: fetch-and-cache for a note
            // opened on a second device isn't wired up yet) - a visible placeholder beats a blank
            // gap, so a missing image doesn't silently disappear.
            <View style={[StyleSheet.absoluteFill, s.placeholder]}>
              <MaterialIcons name="image" size={28} color={C.borderSub} />
            </View>
          )}
          {selected && <View style={s.selectionOutline} pointerEvents="none" />}
        </View>
        {selected && (
          <>
            <TouchableOpacity
              testID={`object-delete-${object.id}`}
              style={s.deleteHandle}
              onPress={() => onRequestDelete(object.id)}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            >
              <MaterialIcons name="close" size={16} color={C.primaryFg} />
            </TouchableOpacity>

            <GestureDetector gesture={resizeTopLeft}>
              <View testID={`object-resize-tl-${object.id}`} style={[s.resizeHandle, s.resizeTopLeft]} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }} />
            </GestureDetector>
            <GestureDetector gesture={resizeTopRight}>
              <View testID={`object-resize-tr-${object.id}`} style={[s.resizeHandle, s.resizeTopRight]} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }} />
            </GestureDetector>
            <GestureDetector gesture={resizeBottomLeft}>
              <View testID={`object-resize-bl-${object.id}`} style={[s.resizeHandle, s.resizeBottomLeft]} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }} />
            </GestureDetector>
            <GestureDetector gesture={resizeBottomRight}>
              <View testID={`object-resize-br-${object.id}`} style={[s.resizeHandle, s.resizeBottomRight]} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }} />
            </GestureDetector>
          </>
        )}
      </Animated.View>
    </GestureDetector>
  );
}

const s = StyleSheet.create({
  paddingHalo: {
    backgroundColor: C.bg,
    borderRadius: radius.sm,
  },
  imageInset: {
    position: 'absolute',
    left: PADDING,
    top: PADDING,
  },
  placeholder: {
    backgroundColor: C.surfaceHi,
    borderRadius: radius.sm,
    justifyContent: 'center',
    alignItems: 'center',
  },
  selectionOutline: {
    ...StyleSheet.absoluteFillObject,
    borderWidth: 2,
    borderColor: C.primary,
    borderRadius: radius.sm,
  },
  // Top-center, not a corner - the four corners are now all occupied by resize handles.
  deleteHandle: {
    position: 'absolute',
    top: -14,
    left: '50%',
    marginLeft: -12,
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: C.error,
    justifyContent: 'center',
    alignItems: 'center',
  },
  resizeHandle: {
    position: 'absolute',
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: C.primaryFg,
    borderWidth: 2,
    borderColor: C.primary,
  },
  resizeTopLeft: { top: -10, left: -10 },
  resizeTopRight: { top: -10, right: -10 },
  resizeBottomLeft: { bottom: -10, left: -10 },
  resizeBottomRight: { bottom: -10, right: -10 },
});
