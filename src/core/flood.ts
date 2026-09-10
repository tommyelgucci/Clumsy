import type { Rect } from './types';

/**
 * Line-sweep flood fill and its two follow-up passes (grow the border,
 * apply the color) — pure, no `Renderer`/`Engine`, no DOM, on purpose:
 * this is exactly what needs to also run inside a Worker
 * (`workers/floodFill.worker.ts`), which sees none of those three
 * things. Ported from Trace's `core/flood.ts` (same owner, same pattern
 * — see CLAUDE.md); nothing here is camera- or monetization-specific, so
 * it ports as-is, no redesign, same exception `brush.ts`/`palettes.ts`
 * already got.
 */

export interface FloodBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface FloodMatchResult extends FloodBounds {
  filled: Uint8Array;
}

/**
 * Scan-line connected-region fill shared by `floodMatch` and
 * `floodOpenMask`: whatever "open" means (color similarity, or "not
 * behind a wall") is `isOpen`'s problem, not this loop's — far less
 * stack traffic than a per-pixel recursive fill, which blows up on a
 * large canvas.
 */
function scanlineFill(isOpen: (i: number) => boolean, w: number, h: number, sx: number, sy: number): FloodMatchResult {
  const filled = new Uint8Array(w * h);
  const stack: number[] = [sx, sy];
  let minX = sx;
  let minY = sy;
  let maxX = sx;
  let maxY = sy;

  while (stack.length > 0) {
    const y = stack.pop()!;
    const x = stack.pop()!;
    if (filled[y * w + x]) continue;

    let left = x;
    while (left > 0 && !filled[y * w + left - 1] && isOpen(y * w + left - 1)) left--;
    let right = x;
    while (right < w - 1 && !filled[y * w + right + 1] && isOpen(y * w + right + 1)) right++;

    for (let i = left; i <= right; i++) filled[y * w + i] = 1;
    if (left < minX) minX = left;
    if (right > maxX) maxX = right;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;

    for (const ny of [y - 1, y + 1]) {
      if (ny < 0 || ny >= h) continue;
      for (let i = left; i <= right; i++) {
        if (!filled[ny * w + i] && isOpen(ny * w + i)) {
          stack.push(i, ny);
        }
      }
    }
  }

  return { filled, minX, minY, maxX, maxY };
}

/**
 * Color-similarity connected region from `(sx,sy)` over `reference`
 * (RGBA, `w`×`h`). This alone can't tell a real gap in the ink apart from
 * open paper — see `buildWallMask`/`closeGaps`/`floodOpenMask` below for
 * the pipeline that can.
 */
export function floodMatch(reference: Uint8Array, w: number, h: number, sx: number, sy: number, tolerance: number): FloodMatchResult {
  const start = (sy * w + sx) * 4;
  const sr = reference[start];
  const sg = reference[start + 1];
  const sb = reference[start + 2];
  const sa = reference[start + 3];
  const tol = tolerance * 255;

  const isOpen = (i: number) => {
    const o = i * 4;
    return Math.abs(reference[o] - sr) <= tol && Math.abs(reference[o + 1] - sg) <= tol && Math.abs(reference[o + 2] - sb) <= tol && Math.abs(reference[o + 3] - sa) <= tol;
  };

  return scanlineFill(isOpen, w, h, sx, sy);
}

/**
 * Boolean "wall" — 1 where `reference` differs from the seed color by
 * more than `tolerance`, i.e. the exact inverse of `floodMatch`'s
 * per-pixel test. Kept separate from the fill itself so `closeGaps` can
 * bridge small breaks in it BEFORE anything floods through them — a real
 * gap in a hand-drawn line is exactly the failure case a plain
 * tolerance-only flood fill can't tell apart from open paper.
 */
export function buildWallMask(reference: Uint8Array, w: number, h: number, sx: number, sy: number, tolerance: number): Uint8Array {
  const start = (sy * w + sx) * 4;
  const sr = reference[start];
  const sg = reference[start + 1];
  const sb = reference[start + 2];
  const sa = reference[start + 3];
  const tol = tolerance * 255;

  const wall = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const o = i * 4;
    const matchesSeed = Math.abs(reference[o] - sr) <= tol && Math.abs(reference[o + 1] - sg) <= tol && Math.abs(reference[o + 2] - sb) <= tol && Math.abs(reference[o + 3] - sa) <= tol;
    wall[i] = matchesSeed ? 0 : 1;
  }
  return wall;
}

function dilate3x3(mask: Uint8Array, w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (mask[i]) {
        out[i] = 1;
        continue;
      }
      let hit = false;
      for (let dy = -1; dy <= 1 && !hit; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= w) continue;
          if (mask[ny * w + nx]) {
            hit = true;
            break;
          }
        }
      }
      out[i] = hit ? 1 : 0;
    }
  }
  return out;
}

function erode3x3(mask: Uint8Array, w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!mask[i]) {
        out[i] = 0;
        continue;
      }
      // Treat the canvas edge as "set" (not eroding away there): a wall
      // that legitimately runs off the edge of the document shouldn't
      // shrink back from it just because there's no neighbor to sample.
      let allSet = true;
      for (let dy = -1; dy <= 1 && allSet; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= w) continue;
          if (!mask[ny * w + nx]) {
            allSet = false;
            break;
          }
        }
      }
      out[i] = allSet ? 1 : 0;
    }
  }
  return out;
}

/**
 * Gap closure: a morphological close (dilate then erode, `radius` times
 * each) on `wall` — bridges breaks up to about `2*radius` pixels wide
 * without permanently widening the wall's own footprint (the erode pass
 * undoes the dilation everywhere except inside a now-bridged gap).
 * `radius <= 0` is a no-op, same shape as `growFilled`'s `expand`.
 *
 * This is genuinely different from `growFilled`: that one runs AFTER the
 * fill and only affects the filled region's own edge (fixing the
 * antialiasing sliver between fill and ink). This runs BEFORE the fill
 * and decides whether the flood can leak through a broken line at all.
 */
export function closeGaps(wall: Uint8Array, w: number, h: number, radius: number): Uint8Array {
  if (radius <= 0) return wall.slice();
  let m = wall;
  for (let i = 0; i < radius; i++) m = dilate3x3(m, w, h);
  for (let i = 0; i < radius; i++) m = erode3x3(m, w, h);
  return m;
}

/** Flood fill over a boolean wall mask (post `closeGaps`) instead of a
 *  raw color tolerance test — the "gap closure" bucket-fill pipeline. */
export function floodOpenMask(wall: Uint8Array, w: number, h: number, sx: number, sy: number): FloodMatchResult {
  return scanlineFill((i) => !wall[i], w, h, sx, sy);
}

/**
 * Grows `filled` in place by `expand` pixels — avoids the white sliver
 * antialiasing on the line leaves between the fill and the ink (fill
 * expansion / bleed). Each pass can only reach one pixel past what's
 * already filled, so after `expand` passes nothing outside `bounds`
 * widened by `expand` could have changed — bounding the loop to that box,
 * instead of scanning the whole canvas, is the difference between
 * millions of checks and a few thousand on a large document with a small
 * fill. Returns the already-widened box.
 */
export function growFilled(filled: Uint8Array, w: number, h: number, bounds: FloodBounds, expand: number): FloodBounds {
  const boundMinX = Math.max(0, bounds.minX - expand);
  const boundMinY = Math.max(0, bounds.minY - expand);
  const boundMaxX = Math.min(w - 1, bounds.maxX + expand);
  const boundMaxY = Math.min(h - 1, bounds.maxY + expand);

  for (let pass = 0; pass < expand; pass++) {
    const grown = filled.slice();
    for (let y = boundMinY; y <= boundMaxY; y++) {
      for (let x = boundMinX; x <= boundMaxX; x++) {
        if (filled[y * w + x]) continue;
        const up = y > 0 && filled[(y - 1) * w + x];
        const down = y < h - 1 && filled[(y + 1) * w + x];
        const lf = x > 0 && filled[y * w + x - 1];
        const rt = x < w - 1 && filled[y * w + x + 1];
        if (up || down || lf || rt) grown[y * w + x] = 1;
      }
    }
    filled.set(grown);
  }

  return { minX: boundMinX, minY: boundMinY, maxX: boundMaxX, maxY: boundMaxY };
}

/**
 * Paints `color` (0..1) over `filled`'s pixels within `bounds`, in place
 * on `target` (premultiplied RGBA, width `w`). Pixels inside `bounds` but
 * not in `filled` keep whatever they already had — that's what leaves
 * the line's antialiased edge untouched.
 *
 * With `alphaLock`, the bucket can only recolor ink that already existed
 * on this layer — never widen its silhouette. `target[o + 3]` is still
 * the ORIGINAL alpha at this point: each pixel is written exactly once
 * in this loop, so reading it right before overwriting is safe.
 */
export function applyFillColor(target: Uint8Array, w: number, filled: Uint8Array, bounds: FloodBounds, color: { r: number; g: number; b: number }, alphaLock = false): void {
  const cr = Math.round(color.r * 255);
  const cg = Math.round(color.g * 255);
  const cb = Math.round(color.b * 255);
  for (let y = bounds.minY; y <= bounds.maxY; y++) {
    for (let x = bounds.minX; x <= bounds.maxX; x++) {
      const i = y * w + x;
      if (!filled[i]) continue;
      const o = i * 4;
      if (alphaLock && target[o + 3] === 0) continue;
      target[o] = cr;
      target[o + 1] = cg;
      target[o + 2] = cb;
      target[o + 3] = 255;
    }
  }
}

/** Cuts a sub-rect out of an RGBA buffer of width `stride`. */
export function extractRect(src: Uint8Array, stride: number, r: Rect): Uint8Array {
  const w = r.x2 - r.x;
  const h = r.y2 - r.y;
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const from = ((r.y + y) * stride + r.x) * 4;
    out.set(src.subarray(from, from + w * 4), y * w * 4);
  }
  return out;
}
