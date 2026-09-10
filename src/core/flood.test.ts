/**
 * Unit tests for flood.ts — pure, no GPU or DOM, which is exactly why it
 * could move into a worker (see workers/floodFill.worker.ts). Ported
 * from Trace's flood.test.ts.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { applyFillColor, buildWallMask, closeGaps, extractRect, floodMatch, floodOpenMask, growFilled } from './flood.ts';

/** `w`×`h` opaque white paper (255,255,255,255), with a `size`×`size`
 *  opaque black square at `(ox,oy)` — the line the bucket has to respect. */
function paperWithSquare(w: number, h: number, ox: number, oy: number, size: number): Uint8Array {
  const px = new Uint8Array(w * h * 4);
  for (let i = 0; i < px.length; i += 4) {
    px[i] = 255;
    px[i + 1] = 255;
    px[i + 2] = 255;
    px[i + 3] = 255;
  }
  for (let y = oy; y < oy + size; y++) {
    for (let x = ox; x < ox + size; x++) {
      const o = (y * w + x) * 4;
      px[o] = 0;
      px[o + 1] = 0;
      px[o + 2] = 0;
      px[o + 3] = 255;
    }
  }
  return px;
}

describe('floodMatch', () => {
  test('fills only the connected region of the same color, respecting a border', () => {
    const w = 20;
    const h = 20;
    const px = paperWithSquare(w, h, 8, 8, 4); // black 4x4 square at 8..11 on both axes
    const { filled, minX, minY, maxX, maxY } = floodMatch(px, w, h, 0, 0, 0.1);
    // The start point (0,0) is white: the filled region is the whole
    // paper minus the black square — its bounds touch the canvas edges,
    // not the square.
    assert.equal(minX, 0);
    assert.equal(minY, 0);
    assert.equal(maxX, w - 1);
    assert.equal(maxY, h - 1);
    // The square's interior didn't get filled.
    assert.equal(filled[9 * w + 9], 0);
    // A point far from the square did.
    assert.equal(filled[0], 1);
  });

  test('tolerance decides how different a color can be and still count', () => {
    const w = 10;
    const h = 1;
    const px = new Uint8Array(w * 4);
    for (let x = 0; x < w; x++) {
      const o = x * 4;
      // White-to-gray gradient starting at x=5.
      const v = x < 5 ? 255 : 200;
      px[o] = v;
      px[o + 1] = v;
      px[o + 2] = v;
      px[o + 3] = 255;
    }
    const strict = floodMatch(px, w, h, 0, 0, 0.05); // (255-200)/255 ≈ 0.22, doesn't pass
    assert.equal(strict.maxX, 4);
    const loose = floodMatch(px, w, h, 0, 0, 0.3); // does pass
    assert.equal(loose.maxX, w - 1);
  });
});

describe('growFilled', () => {
  test('grows one pixel of radius per pass, bounded to the requested box', () => {
    const w = 10;
    const h = 10;
    const filled = new Uint8Array(w * h);
    filled[5 * w + 5] = 1; // a single filled pixel at the center
    const bounds = growFilled(filled, w, h, { minX: 5, minY: 5, maxX: 5, maxY: 5 }, 2);
    // After 2 passes, the diamond-shaped border reaches distance 2.
    assert.equal(filled[5 * w + 5], 1); // center
    assert.equal(filled[5 * w + 6], 1); // immediate neighbor (pass 1)
    assert.equal(filled[5 * w + 7], 1); // distance 2 (pass 2)
    assert.equal(filled[5 * w + 8], 0); // out of reach
    assert.deepEqual(bounds, { minX: 3, minY: 3, maxX: 7, maxY: 7 });
  });

  test("doesn't grow past the canvas edge", () => {
    const w = 5;
    const h = 5;
    const filled = new Uint8Array(w * h);
    filled[0] = 1; // top-left corner
    const bounds = growFilled(filled, w, h, { minX: 0, minY: 0, maxX: 0, maxY: 0 }, 3);
    assert.equal(bounds.minX, 0);
    assert.equal(bounds.minY, 0);
  });
});

describe('applyFillColor', () => {
  test('paints only the pixels marked in `filled`, leaves the rest untouched', () => {
    const w = 3;
    const target = new Uint8Array([9, 9, 9, 9, /**/ 1, 2, 3, 4, /**/ 9, 9, 9, 9]);
    const filled = new Uint8Array([0, 1, 0]);
    applyFillColor(target, w, filled, { minX: 0, minY: 0, maxX: 2, maxY: 0 }, { r: 1, g: 0, b: 0 });
    assert.deepEqual(Array.from(target.subarray(0, 4)), [9, 9, 9, 9]); // untouched
    assert.deepEqual(Array.from(target.subarray(4, 8)), [255, 0, 0, 255]); // painted
    assert.deepEqual(Array.from(target.subarray(8, 12)), [9, 9, 9, 9]); // untouched
  });

  test('alphaLock only recolors pixels that already had ink', () => {
    // Two pixels marked filled: one already opaque, one fully transparent.
    const w = 2;
    const target = new Uint8Array([10, 20, 30, 255, /**/ 0, 0, 0, 0]);
    const filled = new Uint8Array([1, 1]);
    applyFillColor(target, w, filled, { minX: 0, minY: 0, maxX: 1, maxY: 0 }, { r: 0, g: 1, b: 0 }, true);
    assert.deepEqual(Array.from(target.subarray(0, 4)), [0, 255, 0, 255]); // recolored
    assert.deepEqual(Array.from(target.subarray(4, 8)), [0, 0, 0, 0]); // still empty, not widened
  });
});

describe('buildWallMask / closeGaps / floodOpenMask (gap closure)', () => {
  /** `w`×`h` opaque white paper with a 1px-thick black ring border
   *  between `(lo,lo)` and `(hi,hi)` — a closed outline a bucket fill
   *  should respect, unless `gapAt` pokes a hole in its top edge. */
  function paperWithRing(w: number, h: number, lo: number, hi: number, gapAt?: number): Uint8Array {
    const px = new Uint8Array(w * h * 4);
    for (let i = 0; i < px.length; i += 4) {
      px[i] = 255;
      px[i + 1] = 255;
      px[i + 2] = 255;
      px[i + 3] = 255;
    }
    const setBlack = (x: number, y: number) => {
      const o = (y * w + x) * 4;
      px[o] = 0;
      px[o + 1] = 0;
      px[o + 2] = 0;
      px[o + 3] = 255;
    };
    for (let x = lo; x <= hi; x++) {
      setBlack(x, lo);
      setBlack(x, hi);
    }
    for (let y = lo; y <= hi; y++) {
      setBlack(lo, y);
      setBlack(hi, y);
    }
    if (gapAt !== undefined) {
      // Punch a hole back to white in the top border — a real break in
      // the line, not just a lighter/antialiased pixel.
      const o = (lo * w + gapAt) * 4;
      px[o] = 255;
      px[o + 1] = 255;
      px[o + 2] = 255;
      px[o + 3] = 255;
    }
    return px;
  }

  test('a plain tolerance flood leaks out through a real 1px gap in the outline', () => {
    const w = 20;
    const h = 20;
    const px = paperWithRing(w, h, 5, 14, 9);
    const seedX = 9;
    const seedY = 9; // inside the ring
    const { minY } = floodMatch(px, w, h, seedX, seedY, 0.1);
    // Leaked through the gap in the top border, all the way to the canvas edge.
    assert.equal(minY, 0);
  });

  test('closeGaps bridges the same 1px gap, containing the flood inside the ring', () => {
    const w = 20;
    const h = 20;
    const px = paperWithRing(w, h, 5, 14, 9);
    const seedX = 9;
    const seedY = 9;
    const wall = buildWallMask(px, w, h, seedX, seedY, 0.1);
    const closed = closeGaps(wall, w, h, 1);
    const { minX, minY, maxX, maxY } = floodOpenMask(closed, w, h, seedX, seedY);
    // Stayed inside the ring's border on every side.
    assert.ok(minX > 5, `minX ${minX} should be > 5`);
    assert.ok(minY > 5, `minY ${minY} should be > 5`);
    assert.ok(maxX < 14, `maxX ${maxX} should be < 14`);
    assert.ok(maxY < 14, `maxY ${maxY} should be < 14`);
  });

  test('an intact ring (no gap) contains the flood even with radius 0', () => {
    const w = 20;
    const h = 20;
    const px = paperWithRing(w, h, 5, 14); // no gapAt
    const seedX = 9;
    const seedY = 9;
    const wall = buildWallMask(px, w, h, seedX, seedY, 0.1);
    const { minY } = floodOpenMask(closeGaps(wall, w, h, 0), w, h, seedX, seedY);
    assert.ok(minY > 5);
  });

  test('closeGaps with radius 0 is a no-op copy, not the same array reference', () => {
    const wall = new Uint8Array([1, 0, 1, 0]);
    const closed = closeGaps(wall, 2, 2, 0);
    assert.deepEqual(Array.from(closed), Array.from(wall));
    assert.notEqual(closed, wall);
  });
});

describe('extractRect', () => {
  test("cuts a sub-rectangle respecting the full buffer's stride", () => {
    // 4x2 canvas, values = pixel index (to verify position).
    const w = 4;
    const h = 2;
    const src = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i++) src[i * 4] = i;
    const rect = { x: 1, y: 0, x2: 3, y2: 2 }; // columns 1..2, both rows
    const out = extractRect(src, w, rect);
    assert.equal(out.length, 2 * 2 * 4);
    // Row 0: pixels 1,2. Row 1 (stride 4): pixels 5,6.
    assert.deepEqual([out[0], out[4], out[8], out[12]], [1, 2, 5, 6]);
  });
});
