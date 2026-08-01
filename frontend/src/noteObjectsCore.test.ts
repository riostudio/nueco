/**
 * Unit tests for the free-floating image-object geometry helpers. Framework-free:
 *   node --import ./src/crypto/_ts-resolver.mjs src/noteObjectsCore.test.ts
 */
import {
  clampScale,
  toNormalized,
  toPixels,
  displayDimensions,
  aspectRatio,
  clampCenterToCanvas,
  scaleFromCornerDrag,
  nextZIndex,
  MIN_SCALE,
  MAX_SCALE,
} from './noteObjectsCore.ts';

// Matches DraggableImageObject.tsx's CORNER_DIRECTIONS.
const BOTTOM_RIGHT = { x: Math.SQRT1_2, y: Math.SQRT1_2 };
const BOTTOM_LEFT = { x: -Math.SQRT1_2, y: Math.SQRT1_2 };
const TOP_LEFT = { x: -Math.SQRT1_2, y: -Math.SQRT1_2 };

let passed = 0;
let failed = 0;
function ok(name: string, cond: boolean, detail = '') {
  if (cond) { passed++; console.log('  ✓', name); }
  else { failed++; console.log('  ✗', name, detail); }
}

function approxEqual(a: number, b: number, epsilon = 1e-9): boolean {
  return Math.abs(a - b) < epsilon;
}

function main() {
  console.log('toNormalized / toPixels round-trip:');
  {
    for (const canvasWidth of [320, 400, 768, 1024]) {
      for (const [px, py] of [[0, 0], [100, 50], [canvasWidth, canvasWidth * 2], [37.5, 12.25]]) {
        const norm = toNormalized(px, py, canvasWidth);
        const back = toPixels(norm.x, norm.y, canvasWidth);
        ok(`round-trips at canvasWidth=${canvasWidth} (${px},${py})`,
          approxEqual(back.x, px) && approxEqual(back.y, py),
          JSON.stringify({ norm, back }));
      }
    }
    ok('zero canvas width does not throw / returns origin', JSON.stringify(toNormalized(50, 50, 0)) === JSON.stringify({ x: 0, y: 0 }));
  }

  console.log('displayDimensions - aspect ratio preservation:');
  {
    const cases: [number, number][] = [
      [1200, 1600], // portrait
      [1600, 1200], // landscape
      [1000, 1000], // square
      [4032, 3024], // real camera aspect (4:3)
      [3024, 4032], // real camera aspect, portrait
    ];
    for (const [iw, ih] of cases) {
      const srcRatio = aspectRatio(iw, ih);
      for (const canvasWidth of [320, 768]) {
        for (const scale of [MIN_SCALE, 0.5, 1, 2.5, MAX_SCALE]) {
          const { width, height } = displayDimensions(iw, ih, canvasWidth, scale);
          const outRatio = aspectRatio(width, height);
          ok(`ratio held for ${iw}x${ih} at canvasWidth=${canvasWidth} scale=${scale}`,
            approxEqual(srcRatio, outRatio, 1e-6), `src=${srcRatio} out=${outRatio}`);
        }
      }
    }

    // Sequential re-scales (simulating repeated pinch gestures) must not accumulate drift -
    // each call derives width/height fresh from intrinsic dimensions + the current scale, never
    // from the previous call's output, so there is nothing to accumulate.
    const iw = 4032, ih = 3024;
    const srcRatio = aspectRatio(iw, ih);
    let lastRatio = srcRatio;
    for (const scale of [1, 0.3, 4.8, 0.2, 5, 1.7, 0.9]) {
      const { width, height } = displayDimensions(iw, ih, 400, scale);
      lastRatio = aspectRatio(width, height);
      ok(`ratio held after sequential scale=${scale}`, approxEqual(lastRatio, srcRatio, 1e-6));
    }

    ok('missing intrinsic dimensions -> zero size, no throw', JSON.stringify(displayDimensions(0, 0, 400, 1)) === JSON.stringify({ width: 0, height: 0 }));
  }

  console.log('clampScale:');
  {
    ok('below MIN_SCALE clamps up', clampScale(0.01) === MIN_SCALE);
    ok('above MAX_SCALE clamps down', clampScale(50) === MAX_SCALE);
    ok('in-range value passes through unchanged', clampScale(1.5) === 1.5);
    ok('exactly MIN_SCALE passes through', clampScale(MIN_SCALE) === MIN_SCALE);
    ok('exactly MAX_SCALE passes through', clampScale(MAX_SCALE) === MAX_SCALE);
    ok('NaN falls back to 1 (never produces an unusable scale)', clampScale(NaN) === 1);
  }

  console.log('clampCenterToCanvas:');
  {
    const canvasW = 400, canvasH = 800, displayW = 100, displayH = 150;

    ok('already fully inside -> untouched',
      JSON.stringify(clampCenterToCanvas(200, 400, displayW, displayH, canvasW, canvasH)) === JSON.stringify({ x: 200, y: 400 }));

    const offLeft = clampCenterToCanvas(-500, 400, displayW, displayH, canvasW, canvasH, 24);
    ok('dragged fully off the left edge -> pulled back to leave minVisiblePx showing',
      offLeft.x === 24 - displayW / 2, JSON.stringify(offLeft));

    const offRight = clampCenterToCanvas(5000, 400, displayW, displayH, canvasW, canvasH, 24);
    ok('dragged fully off the right edge -> pulled back',
      offRight.x === canvasW - 24 + displayW / 2, JSON.stringify(offRight));

    const offTop = clampCenterToCanvas(200, -900, displayW, displayH, canvasW, canvasH, 24);
    ok('dragged fully off the top -> pulled back',
      offTop.y === 24 - displayH / 2, JSON.stringify(offTop));

    const offBottom = clampCenterToCanvas(200, 9000, displayW, displayH, canvasW, canvasH, 24);
    ok('dragged fully off the bottom -> pulled back',
      offBottom.y === canvasH - 24 + displayH / 2, JSON.stringify(offBottom));

    // Object bigger than the canvas plus both margins - no clamp target satisfies the
    // constraint on both sides, so this must not throw or return NaN/Infinity.
    const huge = clampCenterToCanvas(10, 10, 10000, 10000, canvasW, canvasH, 24);
    ok('oversized object relative to canvas -> finite fallback, no throw',
      Number.isFinite(huge.x) && Number.isFinite(huge.y), JSON.stringify(huge));
  }

  console.log('scaleFromCornerDrag:');
  {
    const boxW = 200, boxH = 200; // halfDiag = sqrt(100^2+100^2) ≈ 141.42

    // Dragging a bottom-right handle straight down-right (its own outward direction, no
    // rotation) should grow the scale.
    const grown = scaleFromCornerDrag(100, 100, 0, BOTTOM_RIGHT.x, BOTTOM_RIGHT.y, boxW, boxH, 1);
    ok('drag along a corner\'s own outward diagonal grows scale', grown > 1, String(grown));

    // Dragging that same handle the opposite way (up-left, inward) should shrink it.
    const shrunk = scaleFromCornerDrag(-100, -100, 0, BOTTOM_RIGHT.x, BOTTOM_RIGHT.y, boxW, boxH, 1);
    ok('drag opposite a corner\'s outward diagonal shrinks scale', shrunk < 1, String(shrunk));

    // A drag purely PERPENDICULAR to the corner's outward diagonal shouldn't change scale at all
    // (zero radial projection) - e.g. bottom-right's diagonal is (1,1)/sqrt2, so (1,-1) is
    // perpendicular to it.
    const perpendicular = scaleFromCornerDrag(50, -50, 0, BOTTOM_RIGHT.x, BOTTOM_RIGHT.y, boxW, boxH, 1);
    ok('drag perpendicular to the corner diagonal leaves scale unchanged', approxEqual(perpendicular, 1, 1e-9), String(perpendicular));

    // Rotation-independence: the same physical screen-space drag (100,100, i.e. down-right)
    // should grow the BOTTOM_RIGHT handle when unrotated, but should have a DIFFERENT (here,
    // near-zero) effect once the object is rotated 90°, since that drag now points along what
    // used to be a different corner's direction in the object's own rotated frame - proving the
    // rotation term actually participates instead of being a no-op.
    const unrotated = scaleFromCornerDrag(100, 100, 0, BOTTOM_RIGHT.x, BOTTOM_RIGHT.y, boxW, boxH, 1);
    const rotated90 = scaleFromCornerDrag(100, 100, Math.PI / 2, BOTTOM_RIGHT.x, BOTTOM_RIGHT.y, boxW, boxH, 1);
    ok('rotating the object changes how the same screen-space drag affects scale',
      !approxEqual(unrotated, rotated90, 1e-6), `unrotated=${unrotated} rotated90=${rotated90}`);

    // Zero-size box doesn't throw / divide-by-zero into NaN or Infinity.
    const degenerate = scaleFromCornerDrag(50, 50, 0, BOTTOM_RIGHT.x, BOTTOM_RIGHT.y, 0, 0, 1);
    ok('zero-size box -> finite fallback, no throw', Number.isFinite(degenerate), String(degenerate));

    // Result always still respects the same clamp as clampScale itself.
    const extreme = scaleFromCornerDrag(100000, 100000, 0, BOTTOM_RIGHT.x, BOTTOM_RIGHT.y, boxW, boxH, 1);
    ok('extreme drag still clamps to MAX_SCALE', extreme === MAX_SCALE, String(extreme));

    // Sanity: TOP_LEFT and BOTTOM_LEFT are distinct directions, so the same drag projects
    // differently onto each - confirms CORNER_DIRECTIONS actually matter, not just magnitude.
    const viaBottomLeft = scaleFromCornerDrag(100, 100, 0, BOTTOM_LEFT.x, BOTTOM_LEFT.y, boxW, boxH, 1);
    const viaTopLeft = scaleFromCornerDrag(100, 100, 0, TOP_LEFT.x, TOP_LEFT.y, boxW, boxH, 1);
    ok('different corners respond differently to the same drag', !approxEqual(viaBottomLeft, viaTopLeft, 1e-9),
      `bottomLeft=${viaBottomLeft} topLeft=${viaTopLeft}`);
  }

  console.log('nextZIndex:');
  {
    ok('empty array -> 1', nextZIndex([]) === 1);
    ok('single object -> its z + 1', nextZIndex([{ z: 5 }]) === 6);
    ok('non-contiguous z values -> max + 1, not count-based', nextZIndex([{ z: 1 }, { z: 9 }, { z: 3 }]) === 10);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
