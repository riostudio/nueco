/**
 * Pure geometry for free-floating image objects in the note editor: normalized-coordinate
 * conversion, aspect-ratio-preserving sizing, and drag/scale clamping. No react/react-native/
 * expo imports, so this is unit-testable without a device (see noteObjectsCore.test.ts) and
 * every function here is safe to call directly from a gesture worklet on the UI thread (each
 * carries the 'worklet' directive) - see DraggableImageObject.tsx.
 */

export const MIN_SCALE = 0.2;
export const MAX_SCALE = 5;

// An object's un-scaled display width, as a fraction of canvas width - the "base display width"
// scale=1 renders at. Height then follows from the image's own aspect ratio, never independently.
export const BASE_WIDTH_FRACTION = 0.5;

export function clampScale(scale: number): number {
  'worklet';
  if (Number.isNaN(scale)) return 1;
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

// Positions are normalized against canvas WIDTH for both axes (not height) - this is what keeps
// a note's layout proportionally identical whether it's reopened on a phone or a tablet, since
// only width varies the same way at render time that it did at author time (height doesn't
// track anything stable - see NoteImageCanvas's own comment on why).
export function toNormalized(px: number, py: number, canvasWidthPx: number): { x: number; y: number } {
  'worklet';
  if (!canvasWidthPx) return { x: 0, y: 0 };
  return { x: px / canvasWidthPx, y: py / canvasWidthPx };
}

export function toPixels(x: number, y: number, canvasWidthPx: number): { x: number; y: number } {
  'worklet';
  return { x: x * canvasWidthPx, y: y * canvasWidthPx };
}

// Uniform scaling only - width comes from canvas width * base fraction * scale, height is
// derived from the image's own intrinsic aspect ratio, never set independently. This is the
// function the "aspect ratio identical before/after any transform" requirement rests on: as
// long as callers only ever go through this (never set width/height directly), the ratio
// can't drift no matter how many times an object is scaled up and down.
export function displayDimensions(
  intrinsicWidth: number,
  intrinsicHeight: number,
  canvasWidthPx: number,
  scale: number
): { width: number; height: number } {
  'worklet';
  if (!intrinsicWidth || !intrinsicHeight) return { width: 0, height: 0 };
  const width = canvasWidthPx * BASE_WIDTH_FRACTION * scale;
  return { width, height: width * (intrinsicHeight / intrinsicWidth) };
}

export function aspectRatio(width: number, height: number): number {
  'worklet';
  if (!height) return 0;
  return width / height;
}

function clamp1D(center: number, displaySize: number, canvasSize: number, minVisible: number): number {
  'worklet';
  const min = minVisible - displaySize / 2;
  const max = canvasSize - minVisible + displaySize / 2;
  // The object is wider/taller than the canvas plus both margins - no position satisfies
  // "minVisible on every side", so just center it as a reasonable best effort instead of
  // clamping into a degenerate (min > max) range.
  if (min > max) return (min + max) / 2;
  return Math.min(max, Math.max(min, center));
}

// Keeps at least `minVisiblePx` of the object's bounding box within the canvas rect after a
// drag ends, operating on the object's CENTER point in pixels - "keep objects reachable"
// constraint from the spec, applied once at gesture-end, never mid-drag (dragging fully off
// canvas mid-gesture is allowed; only the resting position after release is clamped).
export function clampCenterToCanvas(
  centerX: number,
  centerY: number,
  displayWidth: number,
  displayHeight: number,
  canvasWidthPx: number,
  canvasHeightPx: number,
  minVisiblePx = 24
): { x: number; y: number } {
  'worklet';
  return {
    x: clamp1D(centerX, displayWidth, canvasWidthPx, minVisiblePx),
    y: clamp1D(centerY, displayHeight, canvasHeightPx, minVisiblePx),
  };
}

// Corner-drag resize: rotates the raw screen-space drag delta back into the object's own
// (unrotated) local frame, then projects it onto the given corner's outward diagonal direction
// to get a signed "how far did this drag grow/shrink the object" distance - independent of the
// object's current rotation, so dragging a corner tracks the finger correctly no matter how the
// object is currently rotated. `cornerDirX/Y` is the corner's outward-facing unit diagonal, e.g.
// bottom-left = (-1/sqrt2, 1/sqrt2), matching DraggableImageObject's CORNER_DIRECTIONS.
export function scaleFromCornerDrag(
  dx: number,
  dy: number,
  rotation: number,
  cornerDirX: number,
  cornerDirY: number,
  boxWidth: number,
  boxHeight: number,
  baseScale: number
): number {
  'worklet';
  const cos = Math.cos(-rotation);
  const sin = Math.sin(-rotation);
  const localDX = dx * cos - dy * sin;
  const localDY = dx * sin + dy * cos;
  const halfDiag = Math.sqrt((boxWidth / 2) ** 2 + (boxHeight / 2) ** 2);
  if (!halfDiag) return baseScale;
  const radial = localDX * cornerDirX + localDY * cornerDirY;
  return clampScale(baseScale * (1 + radial / halfDiag));
}

export function nextZIndex(objects: { z: number }[]): number {
  if (objects.length === 0) return 1;
  return Math.max(...objects.map((o) => o.z)) + 1;
}
