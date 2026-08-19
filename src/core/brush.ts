/**
 * Brush presets, stroke building, and stamp generation. Direct port from
 * Trace (tommyelgucci/Draw) — see CLAUDE.md, "What Clumsyloop is": brushes
 * have nothing to do with the camera or monetization, so this ports as-is,
 * no redesign. Only comments and labels are translated to English; values
 * and logic are unchanged.
 */
import type { BuiltinTextureId } from './brushTexture';
import { OneEuroFilter, clamp, lerp, TAU } from './math';
import type { InputSample, Stamp } from './types';

/** Groups presets in the brush panel; doesn't change how each one draws. */
export type BrushCategory = 'sketch' | 'ink' | 'paint' | 'texture' | 'eraser';

export const BRUSH_CATEGORIES: BrushCategory[] = ['sketch', 'ink', 'paint', 'texture', 'eraser'];

export const BRUSH_CATEGORY_LABELS: Record<BrushCategory, string> = {
  sketch: 'Sketch',
  ink: 'Ink',
  paint: 'Paint',
  texture: 'Texture',
  eraser: 'Eraser',
};

export interface BrushPreset {
  id: string;
  name: string;
  category: BrushCategory;
  /** Base diameter in document pixels. */
  size: number;
  /** Opacity of the whole stroke, 0..1. */
  opacity: number;
  /** Alpha of each individual stamp. Low = gradual buildup. */
  flow: number;
  /** 0 = soft gradient to the center, 1 = hard edge. */
  hardness: number;
  /** Spacing between stamps as a fraction of the diameter. */
  spacing: number;
  /** How much minimum pressure shrinks the size, 0..1. */
  pressureSize: number;
  /** How much minimum pressure reduces alpha, 0..1. */
  pressureOpacity: number;
  /** Flattening of the tip when tilting the pen, 0..1. */
  tiltAspect: number;
  /** Positive thins out when speeding up (nib pen), negative thickens. */
  velocitySize: number;
  /** Stroke stabilization, 0..1. */
  smoothing: number;
  /** Random size variation per stamp, 0..1. */
  jitterSize: number;
  /** Random perpendicular scatter, as a fraction of the diameter. */
  scatter: number;
  /** The tip rotates to follow the stroke direction. */
  followDirection: boolean;
  /** Random rotation per stamp, 0..1 (fraction of ±90°) — what separates a
   *  comb of fixed spikes (0) from a tuft of hair or scattered grass (>0):
   *  same elongated texture, each stamp's orientation randomized instead
   *  of all aligned with the stroke. */
  angleJitter: number;
  /** Tapers both ends of the stroke to a point, 0 = no taper. The actual
   * length in pixels scales with `size` (see `taperScale`), so the same
   * value looks proportional on a fine tip and a thick one. */
  taper: number;
  /** Fixed flattening of the tip, 1 = circle. */
  aspect: number;
  /** Erases instead of painting. */
  erase: boolean;
  /**
   * Per-stamp coverage mask; `null` = smooth tip (the usual circle). A
   * `BuiltinTextureId` references one of the built-in ones; any other
   * string references a `CustomTexture.id` (imported by whoever's
   * drawing) — see `Engine.resolveTexturePixels`.
   */
  textureId: BuiltinTextureId | string | null;
  /**
   * 0..1: how much the finished stroke blends with what's already
   * underneath as pigment (linear space + multiplicative mixing) instead
   * of flat-alpha overlay — see `gl/shaders.ts` (`MIX_FS`). 0 is the usual
   * behavior. Not a physical pigment simulation, just a nudge away from
   * flat digital mixing in that same direction.
   */
  pigmentMix: number;
  /**
   * 0..1: instead of depositing the brush's active color, drags along the
   * color that's ALREADY painted under the tip — wet paint that blends as
   * a finger drags through it, not a fixed color deposit. 0 is the usual
   * behavior. Only picks up what was already on the cel BEFORE this
   * stroke (not what the stroke itself has painted so far) — see
   * `Engine.sampleSmudgeColor`.
   */
  smudge: number;
  /**
   * 0..1: how much "memory" the picked-up color has from one stamp to the
   * next — high lets it dilute slowly, low updates it almost instantly
   * with whatever's right underneath. No effect if `smudge` is 0.
   */
  smudgeLength: number;
}

export const DEFAULT_BRUSHES: BrushPreset[] = [
  // --- Sketch -----------------------------------------------------------
  {
    id: 'pencil',
    name: 'Pencil',
    category: 'sketch',
    size: 6,
    opacity: 0.95,
    flow: 0.55,
    hardness: 0.55,
    spacing: 0.07,
    pressureSize: 0.55,
    pressureOpacity: 0.7,
    tiltAspect: 0.5,
    velocitySize: 0.15,
    smoothing: 0.35,
    jitterSize: 0.12,
    scatter: 0.05,
    followDirection: true,
    angleJitter: 0,
    taper: 0.3,
    aspect: 1,
    erase: false,
    pigmentMix: 0,
    smudge: 0,
    smudgeLength: 0.5,
    // Smooth by default: it's the active brush when the app opens and
    // shouldn't change the usual stroke. The texture is there for anyone
    // who looks for it in the panel.
    textureId: null,
  },
  {
    id: 'pencil-soft',
    name: 'Soft pencil',
    category: 'sketch',
    size: 14,
    opacity: 0.7,
    flow: 0.4,
    hardness: 0.35,
    spacing: 0.08,
    pressureSize: 0.5,
    pressureOpacity: 0.6,
    tiltAspect: 0.6,
    velocitySize: 0.1,
    smoothing: 0.3,
    jitterSize: 0.15,
    scatter: 0.08,
    followDirection: true,
    angleJitter: 0,
    taper: 0.15,
    aspect: 1,
    erase: false,
    pigmentMix: 0,
    smudge: 0,
    smudgeLength: 0.5,
    // At this size the grain already reads: below ~12px it's lost.
    textureId: 'grain',
  },
  {
    id: 'graphite',
    name: 'Graphite',
    category: 'sketch',
    size: 18,
    opacity: 0.85,
    flow: 0.6,
    hardness: 0.45,
    spacing: 0.06,
    pressureSize: 0.4,
    pressureOpacity: 0.5,
    tiltAspect: 0.4,
    velocitySize: 0.1,
    smoothing: 0.3,
    jitterSize: 0.1,
    scatter: 0.04,
    followDirection: true,
    angleJitter: 0,
    taper: 0.25,
    aspect: 0.9,
    erase: false,
    pigmentMix: 0,
    smudge: 0,
    smudgeLength: 0.5,
    textureId: 'grain',
  },
  {
    id: 'charcoal',
    name: 'Charcoal',
    category: 'sketch',
    size: 22,
    opacity: 0.6,
    flow: 0.5,
    hardness: 0.15,
    spacing: 0.07,
    pressureSize: 0.3,
    pressureOpacity: 0.5,
    tiltAspect: 0.7,
    velocitySize: 0,
    smoothing: 0.25,
    jitterSize: 0.2,
    scatter: 0.15,
    followDirection: true,
    angleJitter: 0,
    taper: 0.1,
    aspect: 0.7,
    erase: false,
    pigmentMix: 0,
    smudge: 0,
    smudgeLength: 0.5,
    textureId: 'chalk',
  },

  // --- Ink ----------------------------------------------------------------
  {
    id: 'ink',
    name: 'Ink',
    category: 'ink',
    size: 8,
    opacity: 1,
    flow: 1,
    hardness: 0.95,
    spacing: 0.04,
    pressureSize: 0.85,
    pressureOpacity: 0.1,
    tiltAspect: 0,
    velocitySize: 0.35,
    smoothing: 0.6,
    jitterSize: 0,
    scatter: 0,
    followDirection: true,
    angleJitter: 0,
    taper: 0.45,
    aspect: 1,
    erase: false,
    pigmentMix: 0,
    smudge: 0,
    smudgeLength: 0.5,
    textureId: null,
  },
  {
    id: 'fineliner',
    name: 'Fineliner',
    category: 'ink',
    size: 4,
    opacity: 1,
    flow: 1,
    hardness: 1,
    spacing: 0.03,
    // Nearly constant width: what separates a technical fineliner from
    // "Ink"'s nib, which does react to pressure.
    pressureSize: 0.1,
    pressureOpacity: 0.05,
    tiltAspect: 0,
    velocitySize: 0,
    smoothing: 0.5,
    jitterSize: 0,
    scatter: 0,
    followDirection: true,
    angleJitter: 0,
    taper: 0.2,
    aspect: 1,
    erase: false,
    pigmentMix: 0,
    smudge: 0,
    smudgeLength: 0.5,
    textureId: null,
  },
  {
    id: 'calligraphy',
    name: 'Calligraphy',
    category: 'ink',
    size: 16,
    opacity: 1,
    flow: 1,
    hardness: 0.9,
    spacing: 0.03,
    pressureSize: 0.6,
    pressureOpacity: 0.2,
    // The tip is very flattened and doesn't follow the stroke direction,
    // it follows the pen's angle: what gives a nib pen its thick/thin
    // contrast.
    tiltAspect: 0.9,
    velocitySize: 0.2,
    smoothing: 0.5,
    jitterSize: 0,
    scatter: 0,
    followDirection: false,
    angleJitter: 0,
    taper: 0.15,
    aspect: 0.15,
    erase: false,
    pigmentMix: 0,
    smudge: 0,
    smudgeLength: 0.5,
    textureId: null,
  },
  {
    id: 'marker',
    name: 'Marker',
    category: 'ink',
    size: 28,
    opacity: 0.85,
    flow: 0.9,
    hardness: 0.8,
    spacing: 0.05,
    pressureSize: 0.15,
    pressureOpacity: 0.25,
    tiltAspect: 0.2,
    velocitySize: 0,
    smoothing: 0.4,
    jitterSize: 0,
    scatter: 0,
    followDirection: true,
    angleJitter: 0,
    taper: 0,
    aspect: 0.35,
    erase: false,
    pigmentMix: 0,
    smudge: 0,
    smudgeLength: 0.5,
    textureId: null,
  },

  // --- Paint --------------------------------------------------------------
  {
    id: 'paint',
    name: 'Paint',
    category: 'paint',
    size: 40,
    opacity: 1,
    flow: 0.75,
    hardness: 0.35,
    spacing: 0.06,
    pressureSize: 0.4,
    pressureOpacity: 0.5,
    tiltAspect: 0.6,
    velocitySize: 0,
    smoothing: 0.45,
    jitterSize: 0.08,
    scatter: 0.12,
    followDirection: true,
    angleJitter: 0,
    taper: 0.15,
    aspect: 0.85,
    erase: false,
    pigmentMix: 0,
    smudge: 0,
    smudgeLength: 0.5,
    textureId: 'canvas',
  },
  {
    id: 'watercolor',
    name: 'Watercolor',
    category: 'paint',
    size: 50,
    // Low opacity and flow on purpose: watercolor builds up pass after
    // pass, it doesn't arrive opaque in a single stroke.
    opacity: 0.4,
    flow: 0.12,
    hardness: 0,
    spacing: 0.08,
    pressureSize: 0.2,
    pressureOpacity: 0.6,
    tiltAspect: 0,
    velocitySize: 0,
    smoothing: 0.5,
    jitterSize: 0.05,
    scatter: 0.05,
    followDirection: false,
    angleJitter: 0,
    taper: 0.1,
    aspect: 1,
    erase: false,
    pigmentMix: 0,
    smudge: 0,
    smudgeLength: 0.5,
    // The chalk texture, at low intensity, reads as pigment grain
    // settling into damp paper.
    textureId: 'chalk',
  },
  {
    id: 'gouache',
    name: 'Gouache',
    category: 'paint',
    size: 30,
    opacity: 0.95,
    flow: 0.85,
    hardness: 0.6,
    spacing: 0.05,
    pressureSize: 0.25,
    pressureOpacity: 0.3,
    tiltAspect: 0.3,
    velocitySize: 0,
    smoothing: 0.35,
    jitterSize: 0.05,
    scatter: 0.03,
    followDirection: true,
    angleJitter: 0,
    taper: 0.1,
    aspect: 0.9,
    erase: false,
    pigmentMix: 0,
    smudge: 0,
    smudgeLength: 0.5,
    // Matte and opaque, no grain: watercolor already covers that territory.
    textureId: null,
  },
  {
    id: 'acrylic',
    name: 'Acrylic',
    category: 'paint',
    size: 45,
    opacity: 1,
    flow: 0.9,
    hardness: 0.5,
    spacing: 0.05,
    pressureSize: 0.2,
    pressureOpacity: 0.2,
    tiltAspect: 0.4,
    velocitySize: 0,
    smoothing: 0.3,
    jitterSize: 0.05,
    scatter: 0.05,
    followDirection: true,
    angleJitter: 0,
    taper: 0.1,
    aspect: 0.8,
    erase: false,
    pigmentMix: 0,
    smudge: 0,
    smudgeLength: 0.5,
    textureId: 'canvas',
  },

  // --- Texture --------------------------------------------------------
  {
    id: 'airbrush',
    name: 'Airbrush',
    category: 'texture',
    size: 70,
    opacity: 0.6,
    flow: 0.06,
    hardness: 0,
    spacing: 0.03,
    pressureSize: 0.3,
    pressureOpacity: 0.9,
    tiltAspect: 0,
    velocitySize: 0,
    smoothing: 0.3,
    jitterSize: 0,
    scatter: 0,
    followDirection: false,
    angleJitter: 0,
    taper: 0,
    aspect: 1,
    erase: false,
    pigmentMix: 0,
    smudge: 0,
    smudgeLength: 0.5,
    // With flow this low, any texture would be almost invisible: smooth.
    textureId: null,
  },
  {
    id: 'airbrush-splatter',
    name: 'Splatter airbrush',
    category: 'texture',
    size: 60,
    // More opaque and more flow than the smooth airbrush: otherwise the
    // splatter mask leaves it nearly invisible, as it did when tested on
    // the smooth one.
    opacity: 0.7,
    flow: 0.2,
    hardness: 0,
    spacing: 0.04,
    pressureSize: 0.25,
    pressureOpacity: 0.6,
    tiltAspect: 0,
    velocitySize: 0,
    smoothing: 0.35,
    jitterSize: 0,
    scatter: 0.1,
    followDirection: false,
    angleJitter: 0,
    taper: 0,
    aspect: 1,
    erase: false,
    pigmentMix: 0,
    smudge: 0,
    smudgeLength: 0.5,
    textureId: 'splatter',
  },
  {
    id: 'pastel',
    name: 'Pastel',
    category: 'texture',
    size: 34,
    opacity: 0.75,
    flow: 0.5,
    hardness: 0.2,
    spacing: 0.08,
    pressureSize: 0.3,
    pressureOpacity: 0.4,
    tiltAspect: 0.6,
    velocitySize: 0,
    smoothing: 0.3,
    jitterSize: 0.2,
    scatter: 0.2,
    followDirection: false,
    angleJitter: 0,
    taper: 0,
    aspect: 0.7,
    erase: false,
    pigmentMix: 0,
    smudge: 0,
    smudgeLength: 0.5,
    textureId: 'chalk',
  },
  {
    id: 'canvas-weave',
    name: 'Canvas texture',
    category: 'texture',
    size: 55,
    opacity: 0.5,
    flow: 0.35,
    hardness: 0.4,
    spacing: 0.1,
    pressureSize: 0.15,
    pressureOpacity: 0.3,
    tiltAspect: 0.2,
    velocitySize: 0,
    smoothing: 0.3,
    jitterSize: 0.05,
    scatter: 0.05,
    followDirection: true,
    angleJitter: 0,
    taper: 0,
    aspect: 0.6,
    erase: false,
    pigmentMix: 0,
    smudge: 0,
    smudgeLength: 0.5,
    textureId: 'canvas',
  },
  {
    id: 'grass-scatter',
    name: 'Scattered grass',
    category: 'texture',
    size: 26,
    opacity: 1,
    flow: 0.9,
    hardness: 0.75,
    spacing: 0.05,
    pressureSize: 0.2,
    pressureOpacity: 0.2,
    tiltAspect: 0,
    velocitySize: 0,
    smoothing: 0.2,
    jitterSize: 0.15,
    scatter: 0.55,
    followDirection: false,
    // Very elongated elliptical tip + random rotation on each stamp, no
    // texture at all: the same combination MyPaint's (CC0)
    // classic/long_grass and classic/short_grass use for the same
    // effect — aspect here is the inverse of their elliptical_dab_ratio
    // (3.8-3.9).
    angleJitter: 0.8,
    taper: 0,
    aspect: 0.22,
    erase: false,
    pigmentMix: 0,
    smudge: 0,
    smudgeLength: 0.5,
    textureId: null,
  },
  {
    id: 'hair-scatter',
    name: 'Scattered hair',
    category: 'texture',
    size: 16,
    opacity: 1,
    flow: 0.95,
    hardness: 0.65,
    spacing: 0.04,
    pressureSize: 0.15,
    pressureOpacity: 0.15,
    tiltAspect: 0,
    velocitySize: 0,
    smoothing: 0.2,
    jitterSize: 0.2,
    scatter: 0.4,
    followDirection: false,
    // Same mechanics as "Scattered grass" with finer strands and a bit
    // less scatter — like MyPaint's experimental/fur (elliptical_dab_ratio
    // 10, hardness 0.6).
    angleJitter: 0.6,
    taper: 0,
    aspect: 0.12,
    erase: false,
    pigmentMix: 0,
    smudge: 0,
    smudgeLength: 0.5,
    textureId: null,
  },
  {
    id: 'flat-brush',
    name: 'Flat brush',
    category: 'paint',
    size: 90,
    opacity: 1,
    flow: 0.85,
    hardness: 0.85,
    spacing: 0.12,
    pressureSize: 0.2,
    pressureOpacity: 0.2,
    tiltAspect: 0,
    velocitySize: 0,
    smoothing: 0.25,
    jitterSize: 0.05,
    scatter: 0,
    // `followDirection: false` is what makes it genuinely flat, not just
    // a flattened ellipse: it keeps the same fixed angle no matter which
    // way it's dragged, so a stroke dragged edge-on comes out wide and
    // one dragged in profile comes out thin — the edge of a flat brush
    // held still, not a tip that turns with the stroke.
    followDirection: false,
    angleJitter: 0,
    taper: 0,
    // aspect at 1 on purpose: the "flat" texture ALREADY carries the
    // torn horizontal-bar shape (see `generateBrushTexturePixels`, the
    // 'flat' case). The shader maps the texture onto the stamp's
    // UNflattened space (`vLocal` is computed before `aspect` is
    // applied, see STAMP_VS) — so a low `aspect` here wouldn't "flatten
    // the bar more", it would flatten it TWICE: once from the texture's
    // own shape, once from the stamp's flattening. The result came out
    // as an almost invisible slit, with gaps between stamps instead of a
    // continuous stroke.
    aspect: 1,
    erase: false,
    pigmentMix: 0,
    smudge: 0,
    smudgeLength: 0.5,
    textureId: 'flat',
  },
  {
    id: 'wide-wash',
    name: 'Wide wash',
    category: 'paint',
    size: 130,
    opacity: 0.85,
    flow: 0.6,
    hardness: 0.5,
    spacing: 0.15,
    pressureSize: 0.15,
    pressureOpacity: 0.25,
    tiltAspect: 0.1,
    velocitySize: 0,
    smoothing: 0.3,
    jitterSize: 0.08,
    scatter: 0.03,
    followDirection: false,
    angleJitter: 0,
    taper: 0,
    // aspect at 1 — see the long comment on "flat-brush": the "flat"
    // texture already carries its own bar shape, flattening it again
    // with `aspect` leaves it as an almost invisible slit.
    aspect: 1,
    erase: false,
    // A bit of pigment mixing: covering a lot of area in one pass calls
    // for overlaps to show, not just a flat alpha on top.
    pigmentMix: 0.15,
    smudge: 0,
    smudgeLength: 0.5,
    textureId: 'flat',
  },
  {
    id: 'smudge',
    name: 'Smudge',
    category: 'paint',
    size: 50,
    opacity: 1,
    flow: 1,
    hardness: 0.35,
    // Tight spacing on purpose: "Smudge" picks up color fresh on every
    // batch of stamps (see `Engine.updateSmudgeColor`), so wide spacing
    // would show as jumps in color instead of a continuous drag.
    spacing: 0.06,
    pressureSize: 0.2,
    pressureOpacity: 0,
    tiltAspect: 0,
    velocitySize: 0,
    smoothing: 0.3,
    jitterSize: 0,
    scatter: 0,
    followDirection: false,
    angleJitter: 0,
    taper: 0,
    aspect: 1,
    erase: false,
    pigmentMix: 0,
    // smudge=0.9: almost everything that comes out is what was already
    // painted under the tip, not the active color — like dragging a
    // finger through wet paint. Moderate smudgeLength: it shifts freely
    // when crossing from one color to another without trembling from one
    // stamp to the next.
    smudge: 0.9,
    smudgeLength: 0.55,
    textureId: null,
  },

  // --- Eraser ---------------------------------------------------------
  {
    id: 'eraser',
    name: 'Eraser',
    category: 'eraser',
    size: 40,
    opacity: 1,
    flow: 1,
    hardness: 0.6,
    spacing: 0.05,
    pressureSize: 0.4,
    pressureOpacity: 0.5,
    tiltAspect: 0,
    velocitySize: 0,
    smoothing: 0.4,
    jitterSize: 0,
    scatter: 0,
    followDirection: false,
    angleJitter: 0,
    taper: 0,
    aspect: 1,
    erase: true,
    pigmentMix: 0,
    smudge: 0,
    smudgeLength: 0.5,
    textureId: null,
  },
  {
    id: 'eraser-soft',
    name: 'Soft eraser',
    category: 'eraser',
    size: 40,
    // Partial coverage per stamp: each pass lightens instead of clearing
    // outright — useful for softening an edge instead of cutting it.
    opacity: 0.5,
    flow: 0.6,
    hardness: 0.15,
    spacing: 0.05,
    pressureSize: 0.3,
    pressureOpacity: 0.4,
    tiltAspect: 0,
    velocitySize: 0,
    smoothing: 0.4,
    jitterSize: 0,
    scatter: 0,
    followDirection: false,
    angleJitter: 0,
    taper: 0,
    aspect: 1,
    erase: true,
    pigmentMix: 0,
    smudge: 0,
    smudgeLength: 0.5,
    textureId: null,
  },
];

interface Anchor {
  x: number;
  y: number;
  pressure: number;
  altitude: number;
  azimuth: number;
  time: number;
  /** Speed in px/ms, already smoothed. */
  speed: number;
}

/**
 * Converts pointer samples into evenly spaced stamps.
 *
 * The path uses Catmull-Rom over the already-filtered points, so the
 * curve passes exactly through where the pen was. The cost is one point
 * of delay (the next anchor is needed to compute the tangent), which is
 * offset by the browser's predicted samples.
 */
export class StrokeBuilder {
  private anchors: Anchor[] = [];
  private filterX = new OneEuroFilter();
  private filterY = new OneEuroFilter();
  private leftover = 0;
  private emittedUpTo = 0;
  private speed = 0;
  private lastEmit: { x: number; y: number } | null = null;
  /** Distance traveled since the stroke's first point: the only thing
   * needed for the start-of-stroke taper, which is why it's resolved
   * here on the fly. The end taper can't be — how much is left before
   * the pen lifts isn't known — and `Engine` resolves it by rescaling
   * the tail every frame. */
  private distFromStart = 0;

  private brush: BrushPreset;

  constructor(brush: BrushPreset) {
    this.brush = brush;
    this.configureFilters();
  }

  private configureFilters() {
    // More smoothing = lower cutoff frequency = more inertia.
    const cutoff = lerp(6.0, 0.4, this.brush.smoothing);
    this.filterX = new OneEuroFilter(cutoff, 0.006);
    this.filterY = new OneEuroFilter(cutoff, 0.006);
  }

  get isEmpty() {
    return this.anchors.length === 0;
  }

  begin(sample: InputSample): Stamp[] {
    this.anchors = [];
    this.leftover = 0;
    this.emittedUpTo = 0;
    this.speed = 0;
    this.lastEmit = null;
    this.distFromStart = 0;
    this.configureFilters();
    this.addAnchor(sample);
    // A tap with no drag should still leave a mark: emit the first stamp right away.
    const a = this.anchors[0];
    this.lastEmit = { x: a.x, y: a.y };
    return [this.makeStamp(a, 0, 0)];
  }

  /** Adds a real sample and returns the newly confirmed stamps. */
  push(sample: InputSample): Stamp[] {
    this.addAnchor(sample);
    return this.emitPending(false);
  }

  /**
   * Speculative stamps from the browser's predicted samples. Doesn't
   * mutate state: drawn on a separate layer that gets discarded.
   */
  speculate(predicted: InputSample[]): Stamp[] {
    if (predicted.length === 0 || this.anchors.length === 0) return [];
    const saved = {
      anchors: this.anchors.slice(),
      leftover: this.leftover,
      emittedUpTo: this.emittedUpTo,
      speed: this.speed,
      lastEmit: this.lastEmit ? { ...this.lastEmit } : null,
    };
    // Filters are stateful; cloning them via cheap recomputation:
    // accepted trade-off, speculation uses unfiltered positions — it's
    // throwaway material.
    const out: Stamp[] = [];
    for (const p of predicted) {
      const last = this.anchors[this.anchors.length - 1];
      const dt = Math.max(p.time - last.time, 1);
      const dist = Math.hypot(p.x - last.x, p.y - last.y);
      this.anchors.push({
        x: p.x,
        y: p.y,
        pressure: p.pressure,
        altitude: p.altitude,
        azimuth: p.azimuth,
        time: p.time,
        speed: dist / dt,
      });
      out.push(...this.emitPending(false));
    }
    this.anchors = saved.anchors;
    this.leftover = saved.leftover;
    this.emittedUpTo = saved.emittedUpTo;
    this.speed = saved.speed;
    this.lastEmit = saved.lastEmit;
    return out;
  }

  /** Closes the stroke, flushing the last segment. */
  end(): Stamp[] {
    if (this.anchors.length === 0) return [];
    return this.emitPending(true);
  }

  private addAnchor(sample: InputSample) {
    const x = this.filterX.filter(sample.x, sample.time);
    const y = this.filterY.filter(sample.y, sample.time);
    const prev = this.anchors[this.anchors.length - 1];
    if (prev) {
      const dt = Math.max(sample.time - prev.time, 1);
      const dist = Math.hypot(x - prev.x, y - prev.y);
      // Smooth the speed: without this, size dynamics tremble.
      this.speed = lerp(this.speed, dist / dt, 0.3);
      // Discard samples that add neither curvature nor distance.
      if (dist < 0.02) return;
    }
    this.anchors.push({
      x,
      y,
      pressure: sample.pressure,
      altitude: sample.altitude,
      azimuth: sample.azimuth,
      time: sample.time,
      speed: this.speed,
    });
  }

  /**
   * Walks the not-yet-emitted segments at a constant arc-length step.
   * `flush` also processes the last segment by duplicating the end point.
   */
  private emitPending(flush: boolean): Stamp[] {
    const stamps: Stamp[] = [];
    const pts = this.anchors;
    const lastSegment = flush ? pts.length - 1 : pts.length - 2;

    for (let i = this.emittedUpTo; i < lastSegment; i++) {
      const p0 = pts[Math.max(0, i - 1)];
      const p1 = pts[i];
      const p2 = pts[Math.min(pts.length - 1, i + 1)];
      const p3 = pts[Math.min(pts.length - 1, i + 2)];
      this.emitSegment(p0, p1, p2, p3, stamps);
      this.emittedUpTo = i + 1;
    }
    return stamps;
  }

  private emitSegment(p0: Anchor, p1: Anchor, p2: Anchor, p3: Anchor, out: Stamp[]) {
    const chord = Math.hypot(p2.x - p1.x, p2.y - p1.y);
    if (chord < 1e-4) return;

    // Subdivide the spline into ~1px steps and advance by arc length: so
    // spacing stays even even on a tight curve.
    const steps = Math.max(2, Math.min(256, Math.ceil(chord * 1.5)));
    let prevX = p1.x;
    let prevY = p1.y;

    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      const x = catmullRom(p0.x, p1.x, p2.x, p3.x, t);
      const y = catmullRom(p0.y, p1.y, p2.y, p3.y, t);
      const segLen = Math.hypot(x - prevX, y - prevY);
      if (segLen <= 0) continue;

      const interp: Anchor = {
        x,
        y,
        pressure: lerp(p1.pressure, p2.pressure, t),
        altitude: lerp(p1.altitude, p2.altitude, t),
        azimuth: lerp(p1.azimuth, p2.azimuth, t),
        time: lerp(p1.time, p2.time, t),
        speed: lerp(p1.speed, p2.speed, t),
      };
      const spacingPx = Math.max(
        0.5,
        this.stampSize(interp, this.distFromStart) * this.brush.spacing,
      );

      let travelled = 0;
      while (this.leftover + (segLen - travelled) >= spacingPx) {
        const need = spacingPx - this.leftover;
        travelled += need;
        this.leftover = 0;
        const f = travelled / segLen;
        const sx = lerp(prevX, x, f);
        const sy = lerp(prevY, y, f);
        const dir = this.lastEmit
          ? Math.atan2(sy - this.lastEmit.y, sx - this.lastEmit.x)
          : 0;
        if (this.lastEmit) {
          this.distFromStart += Math.hypot(sx - this.lastEmit.x, sy - this.lastEmit.y);
        }
        out.push(this.makeStamp({ ...interp, x: sx, y: sy }, dir, this.distFromStart));
        this.lastEmit = { x: sx, y: sy };
      }
      this.leftover += segLen - travelled;
      prevX = x;
      prevY = y;
    }
  }

  private stampSize(a: Anchor, distFromStart: number): number {
    const b = this.brush;
    let size = b.size;

    const pressureFactor = 1 - b.pressureSize * (1 - a.pressure);
    size *= pressureFactor;

    if (b.velocitySize !== 0) {
      // A comfortable stroke's typical speed is around 1 px/ms.
      const norm = clamp(a.speed / 2.5, 0, 1);
      size *= 1 - b.velocitySize * norm;
    }
    if (b.taper > 0) size *= taperScale(distFromStart, b);
    return Math.max(0.4, size);
  }

  private makeStamp(a: Anchor, direction: number, distFromStart: number): Stamp {
    const b = this.brush;
    let size = this.stampSize(a, distFromStart);

    if (b.jitterSize > 0) {
      size *= 1 - b.jitterSize * Math.random();
    }

    const alpha = b.flow * (1 - b.pressureOpacity * (1 - a.pressure));

    let x = a.x;
    let y = a.y;
    if (b.scatter > 0) {
      const r = (Math.random() - 0.5) * 2 * b.scatter * size;
      const ang = Math.random() * TAU;
      x += Math.cos(ang) * r;
      y += Math.sin(ang) * r;
    }

    // Tilt flattens the tip perpendicular to the pen's direction, which
    // is what makes a laid-down pencil shade instead of drawing a line.
    let aspect = b.aspect;
    let angle = b.followDirection ? direction : 0;
    if (b.tiltAspect > 0) {
      const tilt = clamp(1 - a.altitude / (Math.PI / 2), 0, 1);
      aspect *= 1 - b.tiltAspect * tilt;
      if (tilt > 0.15) {
        angle = a.azimuth;
        size *= 1 + tilt * 0.6;
      }
    }
    if (b.angleJitter > 0) {
      angle += (Math.random() - 0.5) * 2 * b.angleJitter * (Math.PI / 2);
    }

    return {
      x,
      y,
      size,
      angle,
      alpha: clamp(alpha, 0, 1),
      hardness: b.hardness,
      aspect: clamp(aspect, 0.05, 1),
    };
  }
}

function catmullRom(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const t2 = t * t;
  const t3 = t2 * t;
  return (
    0.5 *
    (2 * p1 +
      (-p0 + p2) * t +
      (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
      (-p0 + 3 * p1 - 3 * p2 + p3) * t3)
  );
}

/** At `taper = 1`, tapers over this many tip diameters: so the taper
 * looks proportional to the brush's size instead of a fixed pixel count,
 * which would be invisible on a thick tip or disproportionate on a fine
 * one. */
export const TAPER_LENGTH_FACTOR = 6;

/** The end never closes to zero size: a real brush stops touching the
 * paper before fully disappearing, and in pixels an exact 0 also
 * triggers `stampSize`'s `Math.max(0.4, size)`, which would break the
 * curve. */
const TAPER_MIN_SCALE = 0.1;

/**
 * 0..1 factor for how close a stamp is to a tapering end. `dist` is the
 * distance in document pixels to that end — from the start for the
 * initial tip, from the end for the closing one — so the same function
 * serves both.
 */
export function taperScale(dist: number, brush: BrushPreset): number {
  if (brush.taper <= 0) return 1;
  const len = brush.size * TAPER_LENGTH_FACTOR * brush.taper;
  if (len <= 0) return 1;
  const t = clamp(dist / len, 0, 1);
  // Ease-out: grows fast right after lifting off the point and settles
  // quickly, like a real pencil tip landing on paper.
  return TAPER_MIN_SCALE + (1 - TAPER_MIN_SCALE) * (1 - (1 - t) * (1 - t));
}
