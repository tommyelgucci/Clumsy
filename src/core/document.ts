/**
 * Document model, ported from Trace's core/document.ts and trimmed to
 * Clumsyloop's v1 scope (see CLAUDE.md, "v1 scope"). Trace is a general
 * -purpose 2D animation tool; Clumsyloop is specifically stop-motion camera
 * capture + drawing on the same timeline, so most of Trace's richer
 * feature set doesn't apply here and was left out on purpose, not by
 * oversight:
 *
 * - No `skeletons`/`meshes`/`LayerRig` — no bone rigging in v1.
 * - No `SpriteSwapCatalog`/`pickVariant` — no lip-sync sprite swapping.
 * - No `TextLayerProps`, no `AdjustmentProps`, no `LayerMask` — no text
 *   layers, adjustment layers, or layer masks in v1.
 * - No `LayerGroup`/`AudioTrack`/`customTextures` — no layer folders,
 *   imported audio, or custom brush textures in v1.
 *
 * What's different from Trace, not just trimmed: `LayerKind` is
 * `'camera' | 'draw'` instead of Trace's `'draw' | 'reference' |
 * 'adjustment'` — a camera layer holds the stop-motion photo sequence
 * (each Cel comes from CameraCapture), a draw layer holds hand-drawn cels
 * (rotoscoping, effects, dialogue bubbles, illustrated backgrounds), and
 * that split is Clumsyloop's actual product differentiator, not Trace's.
 * `TransformTrack`/`Channel` (keyframe animation with easing) stays,
 * because effects and dialogue bubbles plausibly need to animate in/out —
 * unlike Trace, that's not for rigged character motion here.
 */
import type { Surface } from '../gl/renderer';
import { clamp, lerp } from './math';
import type { BlendMode, RGB } from './types';

export type Easing = 'hold' | 'linear' | 'easeIn' | 'easeOut' | 'easeInOut';

export interface Keyframe {
  frame: number;
  value: number;
  easing: Easing;
}

/** Animatable channel of a scalar property. */
export interface Channel {
  /** Value used when there are no keyframes. */
  base: number;
  /** Sorted by `frame`. Empty = static property. */
  keys: Keyframe[];
}

export function channel(base: number): Channel {
  return { base, keys: [] };
}

export const EASINGS: Record<Easing, (t: number) => number> = {
  hold: () => 0,
  linear: (t) => t,
  easeIn: (t) => t * t,
  easeOut: (t) => 1 - (1 - t) * (1 - t),
  easeInOut: (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2),
};

export const EASING_LABELS: Record<Easing, string> = {
  hold: 'Hold',
  linear: 'Linear',
  easeIn: 'Ease in',
  easeOut: 'Ease out',
  easeInOut: 'Ease',
};

/** Channel value at a frame, interpolating between keyframes. */
export function sampleChannel(ch: Channel, frame: number): number {
  const keys = ch.keys;
  if (keys.length === 0) return ch.base;
  if (frame <= keys[0].frame) return keys[0].value;
  const last = keys[keys.length - 1];
  if (frame >= last.frame) return last.value;

  let i = 0;
  while (i < keys.length - 1 && keys[i + 1].frame <= frame) i++;
  const a = keys[i];
  const b = keys[i + 1];
  const span = b.frame - a.frame;
  if (span <= 0) return b.value;
  const t = (frame - a.frame) / span;
  // The easing is defined by the outgoing keyframe, like After Effects.
  return lerp(a.value, b.value, EASINGS[a.easing](t));
}

export function setKeyframe(ch: Channel, frame: number, value: number, easing: Easing = 'easeInOut') {
  const i = ch.keys.findIndex((k) => k.frame === frame);
  if (i >= 0) {
    ch.keys[i] = { frame, value, easing: ch.keys[i].easing };
  } else {
    ch.keys.push({ frame, value, easing });
    ch.keys.sort((a, b) => a.frame - b.frame);
  }
}

export function removeKeyframe(ch: Channel, frame: number) {
  const i = ch.keys.findIndex((k) => k.frame === frame);
  if (i >= 0) ch.keys.splice(i, 1);
}

/** The five interpolable properties of a layer. */
export interface TransformTrack {
  x: Channel;
  y: Channel;
  scale: Channel;
  rotation: Channel;
  opacity: Channel;
}

export const TRANSFORM_PROPS = ['x', 'y', 'scale', 'rotation', 'opacity'] as const;
export type TransformProp = (typeof TRANSFORM_PROPS)[number];

export const TRANSFORM_LABELS: Record<TransformProp, string> = {
  x: 'Position X',
  y: 'Position Y',
  scale: 'Scale',
  rotation: 'Rotation',
  opacity: 'Opacity',
};

export function newTransform(): TransformTrack {
  return {
    x: channel(0),
    y: channel(0),
    scale: channel(1),
    rotation: channel(0),
    opacity: channel(1),
  };
}

export function transformIsIdentity(t: TransformTrack, frame: number): boolean {
  return (
    sampleChannel(t.x, frame) === 0 &&
    sampleChannel(t.y, frame) === 0 &&
    sampleChannel(t.scale, frame) === 1 &&
    sampleChannel(t.rotation, frame) === 0
  );
}

export function hasAnyKeyframes(t: TransformTrack): boolean {
  return TRANSFORM_PROPS.some((p) => t[p].keys.length > 0);
}

/**
 * A drawing. Lives on a frame and holds until the next cel. Same shape
 * regardless of where it came from — a camera-layer Cel's surface holds an
 * uploaded photo, a draw-layer Cel's surface holds a stroke, but both are
 * just a Surface to every function below (`celAt`, compositing, etc.).
 * `Layer.kind` is what tells the UI/engine how to treat the layer's cels
 * (shutter capture vs. brush strokes), not a per-Cel tag.
 */
export interface Cel {
  id: string;
  surface: Surface;
  /** Optional short name, useful for marking key poses. */
  label?: string;
}

/**
 * `camera`: stop-motion photo sequence — each Cel comes from
 * `CameraCapture.capturePhoto()`. `draw`: hand-drawn layer — rotoscoping,
 * effects, dialogue bubbles, illustrated backgrounds. This split is
 * Clumsyloop's actual differentiator (see CLAUDE.md, "What Clumsyloop
 * is") — Trace has no equivalent, its `LayerKind` is about reference
 * material and non-destructive adjustments instead.
 */
export type LayerKind = 'camera' | 'draw';

export interface Layer {
  id: string;
  name: string;
  kind: LayerKind;
  visible: boolean;
  locked: boolean;
  opacity: number;
  blend: BlendMode;
  /** Clips this layer to the alpha of the base layer below it. */
  clipToBelow: boolean;
  /** Painting on this layer only affects pixels that already had alpha > 0
   *  — can't widen the existing silhouette, only recolor/shade inside it. */
  alphaLock: boolean;
  /**
   * `false`: a single cel (at frame 0) visible through the whole
   * animation — backgrounds, solid-color layers. `true`: frame-by-frame.
   */
  animated: boolean;
  /** Key = the frame a cel appears on. */
  cels: Map<number, Cel>;
  transform: TransformTrack;
}

export function newLayer(name: string, animated = true, kind: LayerKind = 'draw'): Layer {
  return {
    id: uid('layer'),
    name,
    kind,
    visible: true,
    locked: false,
    opacity: 1,
    blend: 'normal',
    clipToBelow: false,
    alphaLock: false,
    animated,
    cels: new Map(),
    transform: newTransform(),
  };
}

/** Practical ceiling on `frameCount`. Cels live in a sparse `Map`, so an
 *  empty frame costs no memory — this isn't about the engine, it's about
 *  the timeline UI, which (like Trace's) paints one DOM cell per frame per
 *  layer and isn't virtualized. At 12fps this is ~8 minutes of capture,
 *  well beyond what a single stop-motion clip needs. */
export const MAX_FRAME_COUNT = 6000;

export interface ClumsyloopDocument {
  id: string;
  name: string;
  width: number;
  height: number;
  fps: number;
  frameCount: number;
  /** Layers bottom to top, like the GPU's stack. */
  layers: Layer[];
  paper: RGB;
  /** 0 = transparent canvas, 1 = opaque paper. Matters for draw-only
   *  layers with no camera layer under them (e.g. an illustrated
   *  background drawn before any capture). */
  paperAlpha: number;
  createdAt: number;
  modifiedAt: number;
}

let idCounter = 0;
export function uid(prefix = 'id'): string {
  idCounter += 1;
  return `${prefix}_${Date.now().toString(36)}_${idCounter.toString(36)}`;
}

export function newDocument(
  width = 1080,
  height = 1920,
  fps = 12,
  frameCount = 24,
): ClumsyloopDocument {
  return {
    id: uid('doc'),
    name: 'Untitled',
    width,
    height,
    fps,
    frameCount,
    layers: [],
    paper: { r: 1, g: 1, b: 1 },
    paperAlpha: 1,
    createdAt: Date.now(),
    modifiedAt: Date.now(),
  };
}

/**
 * Cel visible at `frame`: the most recent one at or before that frame. A
 * non-animated layer always uses its single cel, wherever it lives.
 */
export function celAt(layer: Layer, frame: number): Cel | null {
  if (!layer.animated) {
    const first = layer.cels.values().next();
    return first.done ? null : first.value;
  }
  let best: Cel | null = null;
  let bestFrame = -1;
  for (const [f, cel] of layer.cels) {
    if (f <= frame && f > bestFrame) {
      bestFrame = f;
      best = cel;
    }
  }
  return best;
}

/** Frame where the cel visible at `frame` starts, or -1. */
export function celStartFrame(layer: Layer, frame: number): number {
  if (!layer.animated) return layer.cels.size > 0 ? 0 : -1;
  let bestFrame = -1;
  for (const f of layer.cels.keys()) {
    if (f <= frame && f > bestFrame) bestFrame = f;
  }
  return bestFrame;
}

/** How many frames the cel starting at `start` holds on screen. */
export function celHoldLength(layer: Layer, start: number, frameCount: number): number {
  if (!layer.animated) return frameCount;
  let next = frameCount;
  for (const f of layer.cels.keys()) {
    if (f > start && f < next) next = f;
  }
  return next - start;
}

export function sortedCelFrames(layer: Layer): number[] {
  return [...layer.cels.keys()].sort((a, b) => a - b);
}

export function layerIndexById(doc: ClumsyloopDocument, id: string): number {
  return doc.layers.findIndex((l) => l.id === id);
}

/**
 * Groups the stack into clip groups: a base layer and the layers above it
 * that carry `clipToBelow`. This is the renderer's compositing unit.
 */
export interface ClipGroup {
  base: Layer;
  clipped: Layer[];
}

export function buildClipGroups(layers: Layer[]): ClipGroup[] {
  const groups: ClipGroup[] = [];
  for (const layer of layers) {
    if (!layer.clipToBelow || groups.length === 0) {
      groups.push({ base: layer, clipped: [] });
    } else {
      groups[groups.length - 1].clipped.push(layer);
    }
  }
  return groups;
}

export function frameToTimecode(frame: number, fps: number): string {
  const totalSeconds = frame / fps;
  const s = Math.floor(totalSeconds);
  const f = Math.round((totalSeconds - s) * fps);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}+${String(f).padStart(2, '0')}`;
}

export function clampFrame(doc: ClumsyloopDocument, frame: number): number {
  return clamp(Math.round(frame), 0, Math.max(0, doc.frameCount - 1));
}
