/**
 * Handwriting / sketch capture - draw freehand, export as a transparent-background PNG data
 * URI, hand it back to the note editor exactly like a photo/gallery pick. Deliberately no OCR:
 * this is "Add Sketch" (a drawn image), not handwriting-to-text.
 *
 * Touch handling uses react-native-gesture-handler + react-native-reanimated (both already
 * dependencies of this app, wired up via the root GestureHandlerRootView in app/_layout.tsx) -
 * one finger draws, two fingers pinch-zoom/pan around inside the fixed 4:3 viewport. A single
 * PanResponder (this screen's original implementation) can't cleanly distinguish "1 finger" from
 * "2 fingers" for this kind of draw-vs-navigate disambiguation; Gesture.Race is built for exactly
 * this.
 *
 * Strokes are recorded in the canvas's own fixed coordinate space (the raw touch position with
 * the current pan/zoom transform undone), not screen space - so a stroke drawn while zoomed in
 * still lines up correctly when zoomed back out, and the exported snapshot (which captures the
 * canvas's actual rendered content, not however it currently happens to be displayed) always
 * comes out at the canvas's true, un-zoomed size regardless of what zoom/pan state was active
 * when "Done" was tapped.
 *
 * NOTE: this screen cannot be exercised in the sandboxed environment this was written in (no
 * device/simulator with the native Skia/gesture-handler/reanimated modules available). It
 * type-checks cleanly but needs a dedicated manual pass on real hardware before shipping -
 * particularly the 1-finger-draw vs 2-finger-navigate gesture handoff, which is the kind of thing
 * that often needs live tuning.
 */
import React, { useMemo, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Alert } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { MaterialIcons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { useSharedValue, useAnimatedStyle, withTiming, runOnJS } from 'react-native-reanimated';
import { Canvas, Path, Skia, useCanvasRef, ImageFormat, type SkPath } from '@shopify/react-native-skia';
import { setPendingSketch } from '../src/pendingSketch';
import { C, radius, borderWidth } from '../src/theme';

type Point = { x: number; y: number };
type Stroke = { path: SkPath; color: string; strokeWidth: number };

const COLORS = ['#000000', '#C62828', '#1565C0', '#2E7D32', '#F9A825', '#6A1B9A'];
const STROKE_WIDTHS = [3, 6, 10];
const MIN_SCALE = 1;
const MAX_SCALE = 4;

function pathFromPoints(points: Point[]): SkPath {
  const path = Skia.Path.Make();
  if (points.length === 0) return path;
  path.moveTo(points[0].x, points[0].y);
  if (points.length === 1) {
    // A tap with no movement - draw a dot (a zero-length path renders nothing, even with a
    // round strokeCap) by extending a hair's-width so it still shows up as a point.
    path.lineTo(points[0].x + 0.01, points[0].y + 0.01);
  } else {
    for (let i = 1; i < points.length; i++) path.lineTo(points[i].x, points[i].y);
  }
  return path;
}

function clamp(value: number, min: number, max: number): number {
  'worklet';
  return Math.min(max, Math.max(min, value));
}

export default function SketchScreen() {
  const router = useRouter();
  const canvasRef = useCanvasRef();

  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const [currentPoints, setCurrentPoints] = useState<Point[]>([]);
  const [color, setColor] = useState(COLORS[0]);
  const [strokeWidth, setStrokeWidth] = useState(STROKE_WIDTHS[1]);
  const [exporting, setExporting] = useState(false);
  const [isZoomed, setIsZoomed] = useState(false);

  const currentPath = useMemo(
    () => (currentPoints.length > 0 ? pathFromPoints(currentPoints) : null),
    [currentPoints],
  );

  // Zoom/pan transform state (UI-thread shared values, driven by the gestures below).
  const scale = useSharedValue(1);
  const savedScale = useSharedValue(1);
  const translateX = useSharedValue(0);
  const translateY = useSharedValue(0);
  const savedTranslateX = useSharedValue(0);
  const savedTranslateY = useSharedValue(0);
  // Layout size of the (unscaled) canvas frame, needed to clamp panning so zoomed-in content
  // can't be dragged entirely out of view. Set via onLayout below.
  const frameW = useSharedValue(0);
  const frameH = useSharedValue(0);

  const reportZoomed = (zoomed: boolean) => setIsZoomed(zoomed);

  // Drawing is committed via plain React state (setStrokes etc.), which must run on the JS
  // thread - gesture worklets run on the UI thread by default, hence the runOnJS wrappers below.
  const beginStroke = (x: number, y: number) => setCurrentPoints([{ x, y }]);
  const extendStroke = (x: number, y: number) => setCurrentPoints((prev) => [...prev, { x, y }]);
  const commitStroke = () => {
    setCurrentPoints((prev) => {
      if (prev.length > 0) {
        // color/strokeWidth read here directly off React state (this function itself runs on
        // the JS thread via runOnJS, called fresh each time - not a stale worklet closure).
        setStrokes((prevStrokes) => [...prevStrokes, { path: pathFromPoints(prev), color, strokeWidth }]);
      }
      return [];
    });
  };
  const cancelStroke = () => setCurrentPoints([]);

  // One finger: draw. Coordinates are converted from screen space (relative to the unscaled
  // canvasFrame, since the GestureDetector is attached there, outside the transformed
  // Animated.View) into the canvas's own fixed coordinate space by undoing the current pan/zoom.
  const drawGesture = Gesture.Pan()
    .minPointers(1)
    .maxPointers(1)
    .onBegin((e) => {
      'worklet';
      const x = (e.x - translateX.value) / scale.value;
      const y = (e.y - translateY.value) / scale.value;
      runOnJS(beginStroke)(x, y);
    })
    .onUpdate((e) => {
      'worklet';
      const x = (e.x - translateX.value) / scale.value;
      const y = (e.y - translateY.value) / scale.value;
      runOnJS(extendStroke)(x, y);
    })
    .onEnd(() => {
      'worklet';
      runOnJS(commitStroke)();
    })
    .onFinalize((_e, success) => {
      'worklet';
      if (!success) runOnJS(cancelStroke)();
    });

  // Two fingers: pinch to zoom, drag to pan - navigating around inside the fixed 4:3 viewport
  // rather than drawing. Bounds keep at least the full frame's worth of content reachable
  // (can't pan the drawing away entirely) and cap zoom at MAX_SCALE.
  const pinchGesture = Gesture.Pinch()
    .onUpdate((e) => {
      'worklet';
      scale.value = clamp(savedScale.value * e.scale, MIN_SCALE, MAX_SCALE);
      runOnJS(reportZoomed)(scale.value > 1.01);
    })
    .onEnd(() => {
      'worklet';
      savedScale.value = scale.value;
      const maxTx = (frameW.value * (scale.value - 1)) / 2;
      const maxTy = (frameH.value * (scale.value - 1)) / 2;
      translateX.value = withTiming(clamp(translateX.value, -maxTx, maxTx));
      translateY.value = withTiming(clamp(translateY.value, -maxTy, maxTy));
      savedTranslateX.value = clamp(translateX.value, -maxTx, maxTx);
      savedTranslateY.value = clamp(translateY.value, -maxTy, maxTy);
    });

  const panNavigateGesture = Gesture.Pan()
    .minPointers(2)
    .maxPointers(2)
    .onUpdate((e) => {
      'worklet';
      const maxTx = (frameW.value * (scale.value - 1)) / 2;
      const maxTy = (frameH.value * (scale.value - 1)) / 2;
      translateX.value = clamp(savedTranslateX.value + e.translationX, -maxTx, maxTx);
      translateY.value = clamp(savedTranslateY.value + e.translationY, -maxTy, maxTy);
    })
    .onEnd(() => {
      'worklet';
      savedTranslateX.value = translateX.value;
      savedTranslateY.value = translateY.value;
    });

  const navigateGesture = Gesture.Simultaneous(pinchGesture, panNavigateGesture);
  const composedGesture = Gesture.Race(drawGesture, navigateGesture);

  const canvasTransformStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: translateX.value },
      { translateY: translateY.value },
      { scale: scale.value },
    ],
  }));

  const resetZoom = () => {
    scale.value = withTiming(1);
    translateX.value = withTiming(0);
    translateY.value = withTiming(0);
    savedScale.value = 1;
    savedTranslateX.value = 0;
    savedTranslateY.value = 0;
    setIsZoomed(false);
  };

  const undo = () => setStrokes((prev) => prev.slice(0, -1));
  const clear = () => setStrokes([]);
  const cancel = () => router.back();

  const done = () => {
    if (strokes.length === 0) {
      cancel();
      return;
    }
    setExporting(true);
    try {
      const image = canvasRef.current?.makeImageSnapshot();
      if (!image) {
        Alert.alert('Couldn’t export that sketch', 'Have another go whenever.');
        setExporting(false);
        return;
      }
      // PNG (not JPEG) - preserves a transparent background around the ink so it doesn't
      // render as a stray white/black box against the note.
      const base64 = image.encodeToBase64(ImageFormat.PNG);
      setPendingSketch(`data:image/png;base64,${base64}`);
      router.back();
    } catch (e) {
      console.error('Sketch export failed:', e);
      Alert.alert('Couldn’t export that sketch', 'Have another go whenever.');
      setExporting(false);
    }
  };

  // No edges restriction on the SafeAreaView below (unlike most other screens here) - this one
  // has a bottom-anchored toolbar sitting directly against the screen edge, not inside a
  // scrollable area with its own bottom padding, so it needs the bottom safe-area inset too or
  // its controls sit under the system nav bar. Matches editor.tsx/event-editor.tsx's
  // SafeAreaView usage, which have the same bottom-toolbar shape.
  return (
    <SafeAreaView style={s.container}>
      <View style={s.header}>
        <TouchableOpacity testID="sketch-cancel-btn" onPress={cancel} style={s.headerBtn}>
          <Text style={s.headerBtnText}>Cancel</Text>
        </TouchableOpacity>
        <Text style={s.headerTitle}>Draw</Text>
        <TouchableOpacity testID="sketch-done-btn" onPress={done} style={s.headerBtn} disabled={exporting}>
          <Text style={[s.headerBtnText, s.headerBtnDone]}>Done</Text>
        </TouchableOpacity>
      </View>

      {/* canvasArea centers a fixed-aspect-ratio frame instead of drawing edge-to-edge full
          screen height - a full-screen-tall canvas exports a very tall/narrow PNG once scaled
          down to the note's content width, which the note body's height estimator (editor.tsx's
          bodyHeight) can't size for without knowing the image's real dimensions ahead of time.
          A known, fixed 4:3 ratio makes the exported image's height predictable from its width
          alone, so that estimator can budget the right amount of space for it. Pinch/pan
          navigate WITHIN this fixed viewport (see the gestures above) rather than changing its
          size, so that guarantee holds regardless of zoom state. */}
      <View style={s.canvasArea}>
        <View
          style={s.canvasFrame}
          onLayout={(e) => {
            frameW.value = e.nativeEvent.layout.width;
            frameH.value = e.nativeEvent.layout.height;
          }}
        >
          <GestureDetector gesture={composedGesture}>
            <Animated.View style={[s.canvas, canvasTransformStyle]}>
              <Canvas ref={canvasRef} style={s.canvas} opaque={false}>
                {strokes.map((stroke, i) => (
                  <Path
                    key={i}
                    path={stroke.path}
                    color={stroke.color}
                    style="stroke"
                    strokeWidth={stroke.strokeWidth}
                    strokeCap="round"
                    strokeJoin="round"
                  />
                ))}
                {currentPath && (
                  <Path
                    path={currentPath}
                    color={color}
                    style="stroke"
                    strokeWidth={strokeWidth}
                    strokeCap="round"
                    strokeJoin="round"
                  />
                )}
              </Canvas>
            </Animated.View>
          </GestureDetector>
          {isZoomed && (
            <TouchableOpacity testID="sketch-reset-zoom-btn" style={s.resetZoomBtn} onPress={resetZoom}>
              <MaterialIcons name="zoom-out-map" size={18} color={C.primaryFg} />
            </TouchableOpacity>
          )}
        </View>
      </View>

      <View style={s.toolbar}>
        <View style={s.toolRow}>
          {COLORS.map((c) => (
            <TouchableOpacity
              key={c}
              testID={`sketch-color-${c}`}
              style={[s.swatch, { backgroundColor: c }, color === c && s.swatchActive]}
              onPress={() => setColor(c)}
            />
          ))}
        </View>
        <View style={s.toolRow}>
          {STROKE_WIDTHS.map((w) => (
            <TouchableOpacity
              key={w}
              testID={`sketch-width-${w}`}
              style={[s.widthBtn, strokeWidth === w && s.widthBtnActive]}
              onPress={() => setStrokeWidth(w)}
            >
              <View style={[s.widthDot, { width: w + 4, height: w + 4, borderRadius: (w + 4) / 2 }]} />
            </TouchableOpacity>
          ))}
          <View style={s.toolSpacer} />
          <TouchableOpacity testID="sketch-undo-btn" style={s.iconBtn} onPress={undo} disabled={strokes.length === 0}>
            <MaterialIcons name="undo" size={22} color={strokes.length === 0 ? C.borderSub : C.text} />
          </TouchableOpacity>
          <TouchableOpacity testID="sketch-clear-btn" style={s.iconBtn} onPress={clear} disabled={strokes.length === 0}>
            <MaterialIcons name="delete-outline" size={22} color={strokes.length === 0 ? C.borderSub : C.error} />
          </TouchableOpacity>
        </View>
      </View>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg },
  header: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingHorizontal: 20, paddingTop: 8, paddingBottom: 12,
  },
  headerBtn: { paddingVertical: 6, paddingHorizontal: 4 },
  headerBtnText: { fontSize: 16, fontWeight: '600', color: C.textSec },
  headerBtnDone: { color: C.primary },
  headerTitle: { fontSize: 18, fontWeight: '700', color: C.text },
  canvasArea: {
    flex: 1, marginHorizontal: 16, marginBottom: 8,
    justifyContent: 'center',
  },
  // Fixed 4:3 aspect ratio - see the comment above this view in the render.
  canvasFrame: {
    width: '100%', aspectRatio: 4 / 3,
    backgroundColor: '#FFFFFF', borderRadius: radius.md,
    borderWidth: borderWidth.regular, borderColor: C.border,
    overflow: 'hidden',
  },
  canvas: { flex: 1 },
  resetZoomBtn: {
    position: 'absolute', right: 8, bottom: 8,
    width: 32, height: 32, borderRadius: 16,
    justifyContent: 'center', alignItems: 'center',
    backgroundColor: C.text + 'CC',
  },
  toolbar: { paddingHorizontal: 16, paddingBottom: 16, gap: 12 },
  toolRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  swatch: {
    width: 32, height: 32, borderRadius: 16,
    borderWidth: 2, borderColor: 'transparent',
  },
  swatchActive: { borderColor: C.text },
  widthBtn: {
    width: 40, height: 40, borderRadius: 20,
    justifyContent: 'center', alignItems: 'center',
    borderWidth: borderWidth.regular, borderColor: C.border,
  },
  widthBtnActive: { borderColor: C.primary, backgroundColor: C.secondaryTint },
  widthDot: { backgroundColor: C.text },
  toolSpacer: { flex: 1 },
  iconBtn: {
    width: 40, height: 40, justifyContent: 'center', alignItems: 'center',
    borderRadius: 20, backgroundColor: C.surface,
    borderWidth: borderWidth.regular, borderColor: C.border,
  },
});
