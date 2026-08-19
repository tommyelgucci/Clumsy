/**
 * Shared types for Clumsyloop's core engine.
 *
 * This module imports nothing from React or the DOM — the goal is that the
 * engine can be ported to another runtime (Rust/wgpu, WASM) by touching only
 * `gl/`. Ported from Trace (same owner, same pattern) — see CLAUDE.md.
 */

export type Vec2 = { x: number; y: number };

/** Pixel coordinates in document space, origin top-left, Y down. */
export type DocPoint = Vec2;

export type BlendMode =
  | 'normal'
  | 'multiply'
  | 'screen'
  | 'overlay'
  | 'darken'
  | 'lighten'
  | 'colorDodge'
  | 'colorBurn'
  | 'hardLight'
  | 'softLight'
  | 'difference'
  | 'exclusion'
  | 'add';

export const BLEND_MODES: BlendMode[] = [
  'normal',
  'multiply',
  'screen',
  'overlay',
  'darken',
  'lighten',
  'colorDodge',
  'colorBurn',
  'hardLight',
  'softLight',
  'difference',
  'exclusion',
  'add',
];

export const BLEND_LABELS: Record<BlendMode, string> = {
  normal: 'Normal',
  multiply: 'Multiply',
  screen: 'Screen',
  overlay: 'Overlay',
  darken: 'Darken',
  lighten: 'Lighten',
  colorDodge: 'Color Dodge',
  colorBurn: 'Color Burn',
  hardLight: 'Hard Light',
  softLight: 'Soft Light',
  difference: 'Difference',
  exclusion: 'Exclusion',
  add: 'Add',
};

/** Numeric index consumed by the compositing shader. */
export const BLEND_INDEX: Record<BlendMode, number> = {
  normal: 0,
  multiply: 1,
  screen: 2,
  overlay: 3,
  darken: 4,
  lighten: 5,
  colorDodge: 6,
  colorBurn: 7,
  hardLight: 8,
  softLight: 9,
  difference: 10,
  exclusion: 11,
  add: 12,
};

/** Raw input-device sample, already converted to document space. */
export interface InputSample {
  x: number;
  y: number;
  /** 0..1. Devices without pressure report a constant 0.5. */
  pressure: number;
  /** Radians from vertical. 0 = perpendicular to the canvas. */
  altitude: number;
  /** Radians, tilt direction in the canvas plane. */
  azimuth: number;
  /** Milliseconds, monotonic clock. */
  time: number;
  /** true if this sample came from `getPredictedEvents()` and must be discarded afterward. */
  predicted?: boolean;
}

/** A stamp ready to send to the GPU. */
export interface Stamp {
  x: number;
  y: number;
  /** Diameter in document pixels. */
  size: number;
  /** Radians. */
  angle: number;
  /** 0..1, coverage of this particular stamp. */
  alpha: number;
  /** 0..1, 1 = hard edge. */
  hardness: number;
  /** 0..1 flattening applied on the minor axis (1 = circle). */
  aspect: number;
}

/** Integer rectangle in document pixels, `x2`/`y2` exclusive. */
export interface Rect {
  x: number;
  y: number;
  x2: number;
  y2: number;
}

export function emptyRect(): Rect {
  return { x: Infinity, y: Infinity, x2: -Infinity, y2: -Infinity };
}

export function rectIsEmpty(r: Rect): boolean {
  return r.x2 <= r.x || r.y2 <= r.y;
}

export function expandRect(r: Rect, x: number, y: number, radius: number): void {
  if (x - radius < r.x) r.x = x - radius;
  if (y - radius < r.y) r.y = y - radius;
  if (x + radius > r.x2) r.x2 = x + radius;
  if (y + radius > r.y2) r.y2 = y + radius;
}

export function clampRect(r: Rect, w: number, h: number): Rect {
  return {
    x: Math.max(0, Math.floor(r.x)),
    y: Math.max(0, Math.floor(r.y)),
    x2: Math.min(w, Math.ceil(r.x2)),
    y2: Math.min(h, Math.ceil(r.y2)),
  };
}

/** Linear-sRGB color in 0..1 (no alpha; alpha lives on the brush/layer). */
export interface RGB {
  r: number;
  g: number;
  b: number;
}
