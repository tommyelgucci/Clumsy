import { applyFillColor, buildWallMask, closeGaps, extractRect, floodOpenMask, growFilled } from '../core/flood';
import type { Rect } from '../core/types';

/**
 * Separate thread for the expensive CPU part of the bucket fill (wall
 * mask + gap closure + line sweep + edge growth + painting the color) —
 * doesn't touch WebGL or the DOM at all, so it doesn't need to share the
 * GPU context with the main thread: that thread already read
 * `reference`/`target` before sending them here, and only writes the
 * result back to the GPU once it's done. Started as a port of Trace's
 * `workers/floodFill.worker.ts`, then extended: Trace's own bucket tool
 * only has tolerance + edge growth, no actual gap closure (a real break
 * in the line still leaks a plain tolerance flood right through it) — see
 * `Engine.floodFill` for the calling side and `core/flood.ts` for why
 * `closeGaps` is a distinct step from `growFilled`.
 *
 * `self`'s typing is done by hand instead of with TypeScript's `webworker`
 * lib: the rest of the project compiles with `lib: ["ES2022", "DOM", ...]`
 * (`tsconfig.app.json` covers all of `src`, this file included), and
 * mixing both libs in the same project clashes over incompatible global
 * declarations of `self`. With `unknown` in between there's no need to
 * drag in a separate tsconfig just for this file.
 */
interface FloodFillRequest {
  /** Echoed back as-is: the main thread reuses a single worker for every
   *  fill and can have more than one request in flight at once (nothing
   *  blocks the canvas while waiting), so this is what pairs each
   *  response with whoever asked for it. */
  id: number;
  reference: Uint8Array;
  target: Uint8Array;
  w: number;
  h: number;
  sx: number;
  sy: number;
  tolerance: number;
  /** Fill expansion / bleed (`growFilled`): pixels the fill grows past
   *  the wall's edge, to cover the line's antialiasing sliver. */
  expand: number;
  /** Gap closure (`closeGaps`): pixels of break in the line the fill
   *  can't leak through. Distinct from `expand` — see `core/flood.ts`. */
  gapClose: number;
  color: { r: number; g: number; b: number };
  /** With alpha lock, the bucket only recolors ink that already existed
   *  — never widens the layer's silhouette. */
  alphaLock: boolean;
}

export interface FloodFillResponse {
  id: number;
  sub: Uint8Array;
  rect: Rect;
}

type WorkerLike = {
  onmessage: ((ev: MessageEvent<FloodFillRequest>) => void) | null;
  postMessage: (data: FloodFillResponse, transfer: Transferable[]) => void;
};

const ctx = self as unknown as WorkerLike;

ctx.onmessage = (e) => {
  const { id, reference, target, w, h, sx, sy, tolerance, expand, gapClose, color, alphaLock } = e.data;
  const wall = closeGaps(buildWallMask(reference, w, h, sx, sy, tolerance), w, h, gapClose);
  const match = floodOpenMask(wall, w, h, sx, sy);
  const bounds = growFilled(match.filled, w, h, match, expand);
  applyFillColor(target, w, match.filled, bounds, color, alphaLock);
  const rect: Rect = { x: bounds.minX, y: bounds.minY, x2: bounds.maxX + 1, y2: bounds.maxY + 1 };
  const sub = extractRect(target, w, rect);
  ctx.postMessage({ id, sub, rect }, [sub.buffer]);
};
