/**
 * Lasso selection: rasterizing a freehand closed path into a pixel mask,
 * and testing whether a point falls inside it (task 2.17). Pure math, no
 * DOM — unlike Trace's own `core/selection.ts`, which rasterizes through
 * an off-screen `HTMLCanvasElement` (`ctx.fill()`) specifically to get
 * antialiasing for free. That's not available here without breaking
 * CLAUDE.md's "core/ pure, no DOM" rule (Trace's own version of that same
 * rule already carries this one exception; Clumsyloop's doesn't take it),
 * and this project's `core/*.test.ts` files run under plain Node with no
 * DOM at all (see `scripts/register-ts-loader.mjs`) — a canvas-based
 * rasterizer couldn't be unit tested the same way `core/flood.ts` is.
 * A binary (no antialiasing) mask from an even-odd scanline fill is the
 * trade-off: the same hard-edge reasoning `core/flood.ts`'s tolerance
 * test already accepts for a fill boundary applies just as well to a
 * selection boundary.
 */
import type { DocPoint, Rect } from './types';

/** Bounding rect of an open point list, clamped to the document. No
 *  antialiasing slack needed (unlike `core/flood.ts`'s rect helpers,
 *  which pad for bleed) since a selection mask has no soft edge to
 *  account for. */
export function polygonBounds(points: DocPoint[], width: number, height: number): Rect {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return {
    x: Math.max(0, Math.floor(minX)),
    y: Math.max(0, Math.floor(minY)),
    x2: Math.min(width, Math.ceil(maxX)),
    y2: Math.min(height, Math.ceil(maxY)),
  };
}

/**
 * Rasterizes a closed polygon (the last point implicitly connects back
 * to the first) into a 0/1 mask sized to `rect`, not the whole document
 * — callers already have `rect` from `polygonBounds`, and a
 * document-sized mask would waste memory for a small selection.
 * Even-odd scanline fill: for each pixel row, intersect every polygon
 * edge with the row's center line, sort the crossings, and fill the
 * spans between alternating pairs — the standard rule for a
 * self-intersecting path, same as any vector fill uses.
 */
export function rasterizePolygon(points: DocPoint[], rect: Rect): Uint8Array {
  const w = rect.x2 - rect.x;
  const h = rect.y2 - rect.y;
  const mask = new Uint8Array(Math.max(0, w) * Math.max(0, h));
  if (w <= 0 || h <= 0 || points.length < 3) return mask;

  for (let py = 0; py < h; py++) {
    const y = rect.y + py + 0.5;
    const xs: number[] = [];
    for (let i = 0; i < points.length; i++) {
      const a = points[i];
      const b = points[(i + 1) % points.length];
      if (a.y === b.y) continue;
      const lo = a.y < b.y ? a : b;
      const hi = a.y < b.y ? b : a;
      if (y < lo.y || y >= hi.y) continue;
      const t = (y - lo.y) / (hi.y - lo.y);
      xs.push(lo.x + t * (hi.x - lo.x));
    }
    xs.sort((a, b) => a - b);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const xStart = Math.max(rect.x, Math.round(xs[i]));
      const xEnd = Math.min(rect.x2, Math.round(xs[i + 1]));
      for (let x = xStart; x < xEnd; x++) mask[py * w + (x - rect.x)] = 1;
    }
  }
  return mask;
}

/** Whether document point `(x, y)` falls inside a rasterized mask —
 *  used to tell "start a new lasso" apart from "grab the existing
 *  selection to move it". */
export function maskContains(mask: Uint8Array, rect: Rect, x: number, y: number): boolean {
  const px = Math.floor(x) - rect.x;
  const py = Math.floor(y) - rect.y;
  const w = rect.x2 - rect.x;
  const h = rect.y2 - rect.y;
  if (px < 0 || py < 0 || px >= w || py >= h) return false;
  return mask[py * w + px] === 1;
}
