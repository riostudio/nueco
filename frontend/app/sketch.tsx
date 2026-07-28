/**
 * Handwriting / sketch capture - draw freehand, export as a transparent-background PNG data
 * URI, hand it back to the note editor exactly like a photo/gallery pick. Deliberately no OCR:
 * this is "Add Sketch" (a drawn image), not handwriting-to-text.
 *
 * Touch handling uses React Native's built-in PanResponder rather than pulling in
 * react-native-gesture-handler's Gesture API - no existing screen in this app uses
 * Gesture.Pan/GestureDetector (this app's GestureHandlerRootView wrapper exists only because
 * expo-router/react-navigation requires it), so PanResponder avoids introducing a second,
 * redundant gesture pathway for a single-finger drag.
 *
 * NOTE: this screen cannot be exercised in the sandboxed environment this was written in (no
 * device/simulator with the native Skia module available). It type-checks cleanly but needs a
 * dedicated manual pass on real hardware before shipping - see the phase write-up.
 */
import React, { useMemo, useRef, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, PanResponder, Alert } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { MaterialIcons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { Canvas, Path, Skia, useCanvasRef, ImageFormat, type SkPath } from '@shopify/react-native-skia';
import { setPendingSketch } from '../src/pendingSketch';
import { C, radius, borderWidth } from '../src/theme';

type Point = { x: number; y: number };
type Stroke = { path: SkPath; color: string; strokeWidth: number };

const COLORS = ['#000000', '#C62828', '#1565C0', '#2E7D32', '#F9A825', '#6A1B9A'];
const STROKE_WIDTHS = [3, 6, 10];

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

export default function SketchScreen() {
  const router = useRouter();
  const canvasRef = useCanvasRef();

  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const [currentPoints, setCurrentPoints] = useState<Point[]>([]);
  const [color, setColor] = useState(COLORS[0]);
  const [strokeWidth, setStrokeWidth] = useState(STROKE_WIDTHS[1]);
  const [exporting, setExporting] = useState(false);

  const currentPath = useMemo(
    () => (currentPoints.length > 0 ? pathFromPoints(currentPoints) : null),
    [currentPoints],
  );

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: (evt) => {
        const { locationX, locationY } = evt.nativeEvent;
        setCurrentPoints([{ x: locationX, y: locationY }]);
      },
      onPanResponderMove: (evt) => {
        const { locationX, locationY } = evt.nativeEvent;
        setCurrentPoints((prev) => [...prev, { x: locationX, y: locationY }]);
      },
      onPanResponderRelease: () => {
        setCurrentPoints((prev) => {
          if (prev.length > 0) {
            setStrokes((strokesPrev) => [...strokesPrev, { path: pathFromPoints(prev), color, strokeWidth }]);
          }
          return [];
        });
      },
      onPanResponderTerminate: () => setCurrentPoints([]),
    }),
  ).current;

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
        Alert.alert('Error', 'Could not export the sketch. Please try again.');
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
      Alert.alert('Error', 'Could not export the sketch. Please try again.');
      setExporting(false);
    }
  };

  return (
    <SafeAreaView style={s.container} edges={['top']}>
      <View style={s.header}>
        <TouchableOpacity testID="sketch-cancel-btn" onPress={cancel} style={s.headerBtn}>
          <Text style={s.headerBtnText}>Cancel</Text>
        </TouchableOpacity>
        <Text style={s.headerTitle}>Draw</Text>
        <TouchableOpacity testID="sketch-done-btn" onPress={done} style={s.headerBtn} disabled={exporting}>
          <Text style={[s.headerBtnText, s.headerBtnDone]}>Done</Text>
        </TouchableOpacity>
      </View>

      <View style={s.canvasArea} {...panResponder.panHandlers}>
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
    backgroundColor: '#FFFFFF', borderRadius: radius.md,
    borderWidth: borderWidth.regular, borderColor: C.border,
    overflow: 'hidden',
  },
  canvas: { flex: 1 },
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
