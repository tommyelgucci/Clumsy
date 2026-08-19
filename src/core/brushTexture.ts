/**
 * Brush-tip textures: coverage masks for the stamping shader
 * (`uUseTexture`/`uTexture` in `STAMP_FS`).
 *
 * Direct port from Trace (tommyelgucci/Draw) — see CLAUDE.md, "What
 * Clumsyloop is": stamp generation has nothing to do with the camera or
 * monetization, so it ports as-is, no redesign.
 *
 * Pure computation, no DOM or WebGL — this is the only reason it lives in
 * `core/` and not `gl/`: the same pixel buffer serves both to upload the
 * texture to the GPU (`gl/renderer.ts`) and to paint the picker thumbnail
 * in the UI, without duplicating the algorithm in two places or coupling
 * generation to any particular runtime.
 *
 * The shader always reads the alpha channel as coverage
 * (`texture(uTexture, uv).a`). RGB, on the other hand, is only used when
 * the brush explicitly asks for it (`uUseTextureColor` in `STAMP_FS`,
 * turned on by `CustomTexture.hasColor`): the cluster generator can write
 * per-blade shadow/base/highlight there instead of leaving it white. Every
 * other texture (built-in, imported, or other generators) keeps RGB white
 * and leaves `hasColor` unset — the brush tints them with its active
 * color as usual. This is deliberately not something you can infer by
 * looking at the pixels: an imported texture with its own colors (a
 * photo, a PNG with real art) must keep working as a shape mask, not
 * impose its own color by surprise.
 */

export type BuiltinTextureId = 'grain' | 'chalk' | 'canvas' | 'splatter' | 'flat';

export const BUILTIN_TEXTURES: { id: BuiltinTextureId; label: string }[] = [
  { id: 'grain', label: 'Grain' },
  { id: 'chalk', label: 'Chalk' },
  { id: 'canvas', label: 'Canvas' },
  { id: 'splatter', label: 'Splatter' },
  { id: 'flat', label: 'Flat' },
];

const BUILTIN_IDS: readonly string[] = BUILTIN_TEXTURES.map((t) => t.id);

export function isBuiltinTextureId(id: string): id is BuiltinTextureId {
  return BUILTIN_IDS.includes(id);
}

/** Fixed size for every brush-tip texture, built-in or imported — the same
 *  size `gl/renderer.ts` uploads to the GPU. */
export const BRUSH_TEXTURE_SIZE = 128;

/**
 * Brush-tip texture imported by whoever's drawing, unlike the built-in
 * ones: same buffer format (RGBA8, only alpha matters as coverage), but
 * the pixels come from their own PNG, not a deterministic generator.
 * Not yet wired into `ClumsyloopDocument` — custom texture import isn't
 * in v1 scope, this type just exists so the brush/stamp pipeline has
 * somewhere to reference it from once it is.
 */
export interface CustomTexture {
  id: string;
  label: string;
  pixels: Uint8Array;
  /** Absent/`false` on every built-in texture: the brush tints it with
   *  its active color. `true` only when the buffer itself carries color
   *  per blade (a cluster with shadow/base/highlight) — see the file
   *  header. */
  hasColor?: boolean;
}

const SEEDS: Record<BuiltinTextureId, number> = {
  grain: 0x9e3779b1,
  chalk: 0x85ebca77,
  canvas: 0xc2b2ae63,
  splatter: 0x27d4eb2f,
  flat: 0x165667b1,
};

/** Deterministic PRNG: the texture must be identical every session, not fresh noise each time. */
function mulberry32(seed: number) {
  let a = seed | 0;
  return function random() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(Math.max((x - edge0) / (edge1 - edge0), 0), 1);
  return t * t * (3 - 2 * t);
}

/**
 * 2D value noise: a coarse grid of random values, smoothly interpolated
 * between nodes — unlike raw `mulberry32` (independent pixel to pixel, it
 * looks like static), this gives continuous, organic variation, which is
 * what a wisp of smoke needs instead of more speckles.
 */
function makeValueNoise(rand: () => number, cells: number) {
  const grid = new Float32Array((cells + 1) * (cells + 1));
  for (let i = 0; i < grid.length; i++) grid[i] = rand();
  return (u: number, v: number) => {
    const gx = Math.min(cells - 1e-6, Math.max(0, u * cells));
    const gy = Math.min(cells - 1e-6, Math.max(0, v * cells));
    const x0 = Math.floor(gx);
    const y0 = Math.floor(gy);
    const fx = smoothstep(0, 1, gx - x0);
    const fy = smoothstep(0, 1, gy - y0);
    const stride = cells + 1;
    const v00 = grid[y0 * stride + x0];
    const v10 = grid[y0 * stride + x0 + 1];
    const v01 = grid[(y0 + 1) * stride + x0];
    const v11 = grid[(y0 + 1) * stride + x0 + 1];
    const a = v00 * (1 - fx) + v10 * fx;
    const b = v01 * (1 - fx) + v11 * fx;
    return a * (1 - fy) + b * fy;
  };
}

/** Paints a soft dot into `buf`'s alpha channel, without darkening what's
 *  already painted. `color`, if given, is written to RGB the same way as
 *  in `paintBlade` — used by `generateClusterTexturePixels` for sparks. */
function paintDot(
  buf: Uint8Array,
  size: number,
  cx: number,
  cy: number,
  r: number,
  peak: number,
  color?: { r: number; g: number; b: number },
) {
  if (r <= 0) return;
  const x0 = Math.max(0, Math.floor(cx - r));
  const x1 = Math.min(size - 1, Math.ceil(cx + r));
  const y0 = Math.max(0, Math.floor(cy - r));
  const y1 = Math.min(size - 1, Math.ceil(cy + r));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const d = Math.hypot(x - cx, y - cy) / r;
      if (d > 1) continue;
      const a = peak * (1 - smoothstep(0.55, 1, d));
      const i = (y * size + x) * 4 + 3;
      const v = Math.round(a * 255);
      if (v > buf[i]) {
        buf[i] = v;
        if (color) {
          buf[i - 3] = color.r;
          buf[i - 2] = color.g;
          buf[i - 1] = color.b;
        }
      }
    }
  }
}

/**
 * Generates a built-in texture's mask as RGBA8 (`size`×`size`), RGB
 * white, alpha = coverage. Deterministic: the same `id` always produces
 * the same pixels, so the texture doesn't "breathe" between strokes or
 * reloads.
 */
export function generateBrushTexturePixels(id: BuiltinTextureId, size = 128): Uint8Array {
  const buf = new Uint8Array(size * size * 4);
  for (let i = 0; i < buf.length; i += 4) {
    buf[i] = 255;
    buf[i + 1] = 255;
    buf[i + 2] = 255;
    buf[i + 3] = 0;
  }
  const rand = mulberry32(SEEDS[id]);

  switch (id) {
    case 'grain': {
      // Fine stippling: pencil grain on paper, with gaps where the paper
      // shows through between the speckles.
      const cols = 16;
      const cell = size / cols;
      for (let gy = 0; gy < cols; gy++) {
        for (let gx = 0; gx < cols; gx++) {
          if (rand() > 0.8) continue;
          const cx = gx * cell + rand() * cell;
          const cy = gy * cell + rand() * cell;
          const r = cell * (0.18 + rand() * 0.28);
          paintDot(buf, size, cx, cy, r, 0.35 + rand() * 0.65);
        }
      }
      break;
    }
    case 'chalk': {
      // Bigger, more irregular blotches with loose dust on top: the
      // result leaves more paper showing than the fine pencil grain.
      const cols = 7;
      const cell = size / cols;
      for (let gy = 0; gy < cols; gy++) {
        for (let gx = 0; gx < cols; gx++) {
          if (rand() > 0.75) continue;
          const cx = gx * cell + rand() * cell;
          const cy = gy * cell + rand() * cell;
          const r = cell * (0.4 + rand() * 0.5);
          paintDot(buf, size, cx, cy, r, 0.25 + rand() * 0.4);
        }
      }
      for (let i = 0; i < 220; i++) {
        paintDot(buf, size, rand() * size, rand() * size, 0.6 + rand() * 1.4, 0.2 + rand() * 0.3);
      }
      break;
    }
    case 'canvas': {
      // Regular woven pattern (two crossed sines) with some noise, like
      // real canvas weave under paint.
      const freq = (Math.PI * 2 * 9) / size;
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const weave = 0.55 + 0.35 * Math.sin(x * freq) * Math.sin(y * freq);
          const noise = (rand() - 0.5) * 0.08;
          const a = Math.min(1, Math.max(0, weave + noise));
          buf[(y * size + x) * 4 + 3] = Math.round(a * 255);
        }
      }
      break;
    }
    case 'splatter': {
      // A few big opaque blots plus a cloud of small droplets around
      // them: reads as a recognizable airbrush/splatter brush.
      for (let i = 0; i < 9; i++) {
        const r = size * (0.05 + rand() * 0.12);
        paintDot(buf, size, rand() * size, rand() * size, r, 0.75 + rand() * 0.25);
      }
      for (let i = 0; i < 40; i++) {
        const r = size * (0.01 + rand() * 0.025);
        paintDot(buf, size, rand() * size, rand() * size, r, 0.6 + rand() * 0.4);
      }
      break;
    }
    case 'flat': {
      // Solid horizontal bar, not a flattened round tip: torn top/bottom
      // edges (bristles separating, not a perfect rectangle) and internal
      // opacity streaks (each bristle leaves its own mark) — what tells a
      // real flat brush apart from a smooth squashed ellipse. Meant to
      // pair with low `aspect` and `followDirection: false` on the brush
      // (see DEFAULT_BRUSHES in brush.ts): a fixed angle, wide when
      // dragged edge-on, thin when dragged in profile — like holding a
      // flat brush still.
      const cx = size / 2;
      const cy = size / 2;
      const halfW = size * 0.42;
      const halfH = size * 0.16;

      const EDGE_CONTROLS = 20;
      const topNoise = Array.from({ length: EDGE_CONTROLS + 1 }, () => rand());
      const botNoise = Array.from({ length: EDGE_CONTROLS + 1 }, () => rand());
      const noiseAt = (arr: number[], u: number) => {
        const t = u * (arr.length - 1);
        const i0 = Math.floor(t);
        const i1 = Math.min(arr.length - 1, i0 + 1);
        const f = t - i0;
        return arr[i0] * (1 - f) + arr[i1] * f;
      };

      // Bristle streaks: narrow vertical strips (not a gradient across
      // the whole width) with their own opacity, so they read as
      // individual bristles, not a soft shadow.
      const BRISTLE_W = 2.5;
      const streakCols = Math.ceil((halfW * 2) / BRISTLE_W) + 2;
      const streakVals = Array.from({ length: streakCols }, () => 0.55 + rand() * 0.45);
      const streakAt = (px: number) => {
        const t = px / BRISTLE_W;
        const i0 = Math.max(0, Math.min(streakCols - 1, Math.floor(t)));
        const i1 = Math.min(streakCols - 1, i0 + 1);
        const f = Math.min(1, Math.max(0, t - i0));
        return streakVals[i0] * (1 - f) + streakVals[i1] * f;
      };

      const x0 = Math.max(0, Math.floor(cx - halfW - 2));
      const x1 = Math.min(size - 1, Math.ceil(cx + halfW + 2));
      const y0 = Math.max(0, Math.floor(cy - halfH - 2));
      const y1 = Math.min(size - 1, Math.ceil(cy + halfH + 2));

      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const dx = x - cx;
          const dy = y - cy;
          const u = Math.min(1, Math.max(0, (dx / halfW + 1) / 2));
          if (u <= 0 || u >= 1) continue;

          // Each edge "eats" a different fraction of the thickness from
          // its own side — that's what makes the cut irregular, not a
          // perfectly even strip. Deliberately low cap (0.25 instead of,
          // say, 0.7): with both edges eating independently, a high cap
          // lets them touch and pinch the bar into loose pieces
          // (`localTop >= localBot` below) — exactly what's NOT wanted: a
          // solid bar with a torn edge, not a row of separate speckles.
          const topEat = noiseAt(topNoise, u) * halfH * 0.25;
          const botEat = noiseAt(botNoise, u) * halfH * 0.25;
          const localTop = -halfH + topEat;
          const localBot = halfH - botEat;
          if (localTop >= localBot) continue;
          const edge = Math.max(localTop - dy, dy - localBot);
          const edgeAlpha = 1 - smoothstep(-1, 1, edge);

          // Left/right ends: a short transition instead of a perfectly
          // square cut.
          const endFade = smoothstep(0, 0.02, u) * (1 - smoothstep(0.98, 1, u));

          const a = edgeAlpha * endFade * streakAt(x - x0);
          const idx = (y * size + x) * 4 + 3;
          const v = Math.round(Math.min(1, Math.max(0, a)) * 255);
          if (v > buf[idx]) buf[idx] = v;
        }
      }
      break;
    }
  }

  return buf;
}

/**
 * Free-form procedural generator parameters: "grain"/"chalk"/"canvas"/
 * "splatter" (not "flat", which is a distinct shape, see above) are
 * really just this with fixed values (weave for "canvas", speckles for
 * "grain"/"chalk", dust for "chalk"/"splatter") — here they're left
 * continuous, to tune a style instead of picking from four closed molds.
 * Pure computation from `seed`: it doesn't look at or copy any image, so
 * the result carries no one else's rights but whoever moves the sliders.
 */
export interface ParametricTextureParams {
  seed: number;
  /** 0 = no background weave, 1 = strong canvas weave. */
  weave: number;
  /** 0..1: probability of a speckle landing in each grid cell. */
  dotDensity: number;
  /** Cells per side of the grid — more cells, finer and more numerous speckles. */
  dotCells: number;
  dotSizeMin: number;
  dotSizeMax: number;
  dotOpacityMin: number;
  dotOpacityMax: number;
  /** Loose, very small dust speckles, over the main layer. */
  dustCount: number;
  dustOpacityMax: number;
}

export function generateParametricTexturePixels(
  params: ParametricTextureParams,
  size = BRUSH_TEXTURE_SIZE,
): Uint8Array {
  const buf = new Uint8Array(size * size * 4);
  for (let i = 0; i < buf.length; i += 4) {
    buf[i] = 255;
    buf[i + 1] = 255;
    buf[i + 2] = 255;
    buf[i + 3] = 0;
  }
  const rand = mulberry32(params.seed);

  if (params.weave > 0) {
    const freq = (Math.PI * 2 * 9) / size;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const weave = 0.55 + 0.35 * Math.sin(x * freq) * Math.sin(y * freq);
        const a = Math.min(1, Math.max(0, weave)) * params.weave;
        buf[(y * size + x) * 4 + 3] = Math.round(a * 255);
      }
    }
  }

  if (params.dotDensity > 0) {
    const cols = Math.max(2, Math.min(32, Math.round(params.dotCells)));
    const cell = size / cols;
    for (let gy = 0; gy < cols; gy++) {
      for (let gx = 0; gx < cols; gx++) {
        if (rand() > params.dotDensity) continue;
        const cx = gx * cell + rand() * cell;
        const cy = gy * cell + rand() * cell;
        const r = cell * (params.dotSizeMin + rand() * (params.dotSizeMax - params.dotSizeMin));
        const peak = params.dotOpacityMin + rand() * (params.dotOpacityMax - params.dotOpacityMin);
        paintDot(buf, size, cx, cy, r, peak);
      }
    }
  }

  for (let i = 0; i < params.dustCount; i++) {
    const r = size * (0.005 + rand() * 0.015);
    paintDot(buf, size, rand() * size, rand() * size, r, rand() * params.dustOpacityMax);
  }

  return buf;
}

/**
 * Elongated mark (scar, underline, scratch): a horizontal streak with
 * sharp or blunt tips and a clean or torn edge, depending on the
 * parameters — not a closed jar of "scar" and another of "underline", but
 * the two ends of the same roughness knob. A different base shape from
 * `ParametricTextureParams` (radial scatter): everything here is measured
 * along one axis, so it needs its own generator, not a branch of the
 * speckle one. Like any tip texture, it orients with each stamp's
 * rotation — straight by default, aligned with the stroke direction if
 * the brush already turns with it.
 */
export interface StreakTextureParams {
  seed: number;
  /** 0..1: fraction of the texture canvas the length takes up. */
  length: number;
  /** 0..1: thickness at the center, as a fraction of the canvas. */
  thickness: number;
  /** 0..1: how much the tips taper — 0 stays blunt, 1 is almost a point. */
  taper: number;
  /** 0..1: how much the edge trembles relative to a perfectly straight strip. */
  roughness: number;
  opacity: number;
}

export function generateStreakTexturePixels(
  params: StreakTextureParams,
  size = BRUSH_TEXTURE_SIZE,
): Uint8Array {
  const buf = new Uint8Array(size * size * 4);
  for (let i = 0; i < buf.length; i += 4) {
    buf[i] = 255;
    buf[i + 1] = 255;
    buf[i + 2] = 255;
    buf[i + 3] = 0;
  }
  const halfLen = (params.length * size) / 2;
  if (halfLen <= 0) return buf;

  const rand = mulberry32(params.seed);
  // Edge-wobble control points, interpolated along the mark: a coherent
  // wave, not per-pixel noise — per-pixel noise would look like static,
  // not a genuinely torn edge.
  const CONTROLS = 24;
  const edgeNoise = Array.from({ length: CONTROLS + 1 }, () => rand() * 2 - 1);
  const noiseAt = (u: number) => {
    const t = u * CONTROLS;
    const i0 = Math.floor(t);
    const i1 = Math.min(CONTROLS, i0 + 1);
    const f = t - i0;
    return edgeNoise[i0] * (1 - f) + edgeNoise[i1] * f;
  };

  const cx = size / 2;
  const cy = size / 2;
  const baseHalfThick = (params.thickness * size) / 2;
  const reach = halfLen + baseHalfThick + 2;

  for (let y = 0; y < size; y++) {
    const dy = y - cy;
    for (let x = 0; x < size; x++) {
      const dx = x - cx;
      if (Math.abs(dx) > reach) continue;
      const u = Math.min(1, Math.max(0, (dx / halfLen + 1) / 2));
      const endTaper = 1 - params.taper * smoothstep(0.5, 1, Math.abs(dx) / halfLen);
      const wobble = 1 + noiseAt(u) * params.roughness * 0.6;
      const halfThickHere = Math.max(0.5, baseHalfThick * endTaper * wobble);
      const lenFalloff = 1 - smoothstep(halfLen * 0.85, halfLen, Math.abs(dx));
      const edge = Math.abs(dy) - halfThickHere;
      const edgeAlpha = 1 - smoothstep(-1.5, 1.5, edge);
      const a = Math.min(1, Math.max(0, edgeAlpha * lenFalloff)) * params.opacity;
      buf[(y * size + x) * 4 + 3] = Math.round(a * 255);
    }
  }

  return buf;
}

/**
 * Wisp of smoke/mist/cloud: a rounded outline deformed by two-scale value
 * noise (a coarse one for the overall contour, a fine one for internal
 * detail) — a third base shape, neither radial scatter nor a straight
 * axis, so it doesn't reuse the other two generators either.
 */
export interface WispTextureParams {
  seed: number;
  /** 0..1: how much of the canvas the cloud takes up before dissolving. */
  spread: number;
  /** 0..1: how much the outline twists — low gives a rounded cloud, high gives loose tendrils. */
  turbulence: number;
  /** 0..1: how much internal fill there is versus gaps. */
  density: number;
  opacity: number;
}

export function generateWispTexturePixels(
  params: WispTextureParams,
  size = BRUSH_TEXTURE_SIZE,
): Uint8Array {
  const buf = new Uint8Array(size * size * 4);
  for (let i = 0; i < buf.length; i += 4) {
    buf[i] = 255;
    buf[i + 1] = 255;
    buf[i + 2] = 255;
    buf[i + 3] = 0;
  }
  const rand = mulberry32(params.seed);
  const coarse = makeValueNoise(rand, 5);
  const fine = makeValueNoise(rand, 12);

  const cx = size / 2;
  const cy = size / 2;
  const radius = size * 0.5 * Math.max(0.15, params.spread);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - cx;
      const dy = y - cy;
      const dist = Math.hypot(dx, dy) / radius;
      if (dist > 1.7) continue;
      const warp = (coarse(x / size, y / size) - 0.5) * 2 * params.turbulence;
      const shaped = dist - warp * 0.6;
      const contour = 1 - smoothstep(0.3, 1.15, shaped);
      const detail = 0.35 + 0.65 * (params.density * 0.5 + fine(x / size, y / size) * 0.5);
      const a = Math.min(1, Math.max(0, contour * detail)) * params.opacity;
      buf[(y * size + x) * 4 + 3] = Math.round(a * 255);
    }
  }

  return buf;
}

/**
 * Radial burst (lens flare, spark, star, sun): spokes radiating from a
 * central core, tapering to a point, with some wobble of their own length
 * and angle — a fourth base shape, measured in polar coordinates (radius
 * + angle) instead of along a straight axis like the elongated mark.
 */
export interface BurstTextureParams {
  seed: number;
  spokeCount: number;
  /** 0..1: spoke length as a fraction of the canvas. */
  length: number;
  /** 0..1: each spoke's thickness at its base. */
  thickness: number;
  /** 0..1: how much length and angle vary from one spoke to the next. */
  irregularity: number;
  /** 0..1: size of the bright central core; 0 = no core. */
  coreSize: number;
  opacity: number;
}

function angleDistance(a: number, b: number): number {
  let d = Math.abs(a - b) % (Math.PI * 2);
  if (d > Math.PI) d = Math.PI * 2 - d;
  return d;
}

export function generateBurstTexturePixels(
  params: BurstTextureParams,
  size = BRUSH_TEXTURE_SIZE,
): Uint8Array {
  const buf = new Uint8Array(size * size * 4);
  for (let i = 0; i < buf.length; i += 4) {
    buf[i] = 255;
    buf[i + 1] = 255;
    buf[i + 2] = 255;
    buf[i + 3] = 0;
  }
  const rand = mulberry32(params.seed);
  const spokeCount = Math.max(2, Math.round(params.spokeCount));
  const angleStep = (Math.PI * 2) / spokeCount;
  const spokeAngles = Array.from(
    { length: spokeCount },
    (_, i) => i * angleStep + (rand() * 2 - 1) * angleStep * 0.15 * params.irregularity,
  );
  const spokeLengths = Array.from(
    { length: spokeCount },
    () => (size / 2) * params.length * (1 + (rand() * 2 - 1) * params.irregularity * 0.7),
  );
  const baseHalfThick = Math.max(0.6, (params.thickness * size) / 2);

  const cx = size / 2;
  const cy = size / 2;
  const reach = size * 0.72;

  for (let y = 0; y < size; y++) {
    const dy = y - cy;
    for (let x = 0; x < size; x++) {
      const dx = x - cx;
      const r = Math.hypot(dx, dy);
      if (r > reach) continue;
      const theta = Math.atan2(dy, dx);
      let best = 0;
      let bestDelta = Infinity;
      for (let i = 0; i < spokeCount; i++) {
        const d = angleDistance(theta, spokeAngles[i]);
        if (d < bestDelta) {
          bestDelta = d;
          best = i;
        }
      }
      const len = spokeLengths[best];
      if (r > len) continue;
      const crossDist = r * Math.sin(bestDelta);
      const widthHere = baseHalfThick * Math.max(0, 1 - r / len);
      const edge = Math.abs(crossDist) - widthHere;
      const a = Math.min(1, Math.max(0, 1 - smoothstep(-1, 1.2, edge))) * params.opacity;
      const idx = (y * size + x) * 4 + 3;
      const v = Math.round(a * 255);
      if (v > buf[idx]) buf[idx] = v;
    }
  }

  if (params.coreSize > 0) {
    paintDot(buf, size, cx, cy, size * 0.5 * params.coreSize, params.opacity);
  }

  return buf;
}

/**
 * Parallel spikes (comb, bristles): several elongated horizontal marks
 * stacked in even lanes, each with its own edge-roughness seed and
 * length — a comb is this with little variation between spikes; worn
 * bristles, with a lot. With the brush's `angleJitter` at 0 they all come
 * out aligned (comb); raising it, each stamp rotates at random and the
 * result scatters like tufts of hair or grass — the orientation doesn't
 * live in the texture, it lives in how each copy gets stamped.
 */
export interface RakeTextureParams {
  seed: number;
  count: number;
  /** 0..1: each spike's length as a fraction of the canvas. */
  length: number;
  /** 0..1: each spike's thickness relative to its lane. */
  thickness: number;
  /** 0..1: how much length varies from one spike to the next. */
  irregularity: number;
  /** 0..1: how much each spike's edge trembles. */
  roughness: number;
  opacity: number;
}

export function generateRakeTexturePixels(
  params: RakeTextureParams,
  size = BRUSH_TEXTURE_SIZE,
): Uint8Array {
  const buf = new Uint8Array(size * size * 4);
  for (let i = 0; i < buf.length; i += 4) {
    buf[i] = 255;
    buf[i + 1] = 255;
    buf[i + 2] = 255;
    buf[i + 3] = 0;
  }
  const rand = mulberry32(params.seed);
  const count = Math.max(2, Math.round(params.count));
  const laneHeight = size / count;
  const cx = size / 2;

  for (let lane = 0; lane < count; lane++) {
    const cy = laneHeight * (lane + 0.5);
    const halfLen = (size / 2) * params.length * (1 + (rand() * 2 - 1) * params.irregularity * 0.6);
    if (halfLen <= 0) continue;
    const baseHalfThick = Math.max(0.5, laneHeight * 0.5 * params.thickness);

    const CONTROLS = 16;
    const edgeNoise = Array.from({ length: CONTROLS + 1 }, () => rand() * 2 - 1);
    const noiseAt = (u: number) => {
      const t = u * CONTROLS;
      const i0 = Math.floor(t);
      const i1 = Math.min(CONTROLS, i0 + 1);
      const f = t - i0;
      return edgeNoise[i0] * (1 - f) + edgeNoise[i1] * f;
    };

    const y0 = Math.max(0, Math.floor(cy - baseHalfThick - 2));
    const y1 = Math.min(size - 1, Math.ceil(cy + baseHalfThick + 2));
    const x0 = Math.max(0, Math.floor(cx - halfLen - 2));
    const x1 = Math.min(size - 1, Math.ceil(cx + halfLen + 2));
    for (let y = y0; y <= y1; y++) {
      const dy = y - cy;
      for (let x = x0; x <= x1; x++) {
        const dx = x - cx;
        const u = Math.min(1, Math.max(0, (dx / halfLen + 1) / 2));
        // Spikes always taper a little toward the tip, even though the
        // loose elongated mark leaves it optional — so they read as
        // spikes, not bars.
        const endTaper = 1 - 0.5 * smoothstep(0.6, 1, Math.abs(dx) / halfLen);
        const wobble = 1 + noiseAt(u) * params.roughness * 0.6;
        const halfThickHere = Math.max(0.5, baseHalfThick * endTaper * wobble);
        const lenFalloff = 1 - smoothstep(halfLen * 0.85, halfLen, Math.abs(dx));
        const edge = Math.abs(dy) - halfThickHere;
        const edgeAlpha = 1 - smoothstep(-1.2, 1.2, edge);
        const a = Math.min(1, Math.max(0, edgeAlpha * lenFalloff)) * params.opacity;
        const idx = (y * size + x) * 4 + 3;
        const v = Math.round(a * 255);
        if (v > buf[idx]) buf[idx] = v;
      }
    }
  }

  return buf;
}

/** Interpolates along a list of colors as gradient stops (the first at
 *  the blade's base, the last at its tip) — not a single flat color per
 *  blade: real fire is more white/yellow where it's hottest (the base)
 *  and cools to orange/red toward the tip, and even hand-painted hair
 *  usually has a darker base than tip. With one color, there's nothing to
 *  interpolate. */
function lerpColorStops(
  colors: { r: number; g: number; b: number }[],
  u: number,
): { r: number; g: number; b: number } {
  if (colors.length === 1) return colors[0];
  const segs = colors.length - 1;
  const t = Math.min(1, Math.max(0, u)) * segs;
  const i0 = Math.min(segs - 1, Math.floor(t));
  const i1 = i0 + 1;
  const f = t - i0;
  const a = colors[i0];
  const b = colors[i1];
  return {
    r: Math.round(a.r + (b.r - a.r) * f),
    g: Math.round(a.g + (b.g - a.g) * f),
    b: Math.round(a.b + (b.b - a.b) * f),
  };
}

/**
 * Paints ONE blade (a leaf, a blade of grass, a hair, a tongue of flame)
 * that starts at `(bx,by)` and grows toward `angle` — unlike the loose
 * elongated mark (centered, symmetric on both sides), this grows in a
 * single direction from a base, like a real blade actually sprouts from
 * the ground. Reused many times by `generateClusterTexturePixels`, with a
 * different position and angle each time.
 *
 * `curl` is a soft arc (zero at the base and tip, maximum halfway) —
 * nothing bends in a straight line: a real blade yields to its own
 * weight, a hair falls under gravity, a flame winds.
 *
 * `colors`, if given, is a gradient (see `lerpColorStops`) written to the
 * texel's own RGB wherever this blade wins the alpha channel — so a
 * single texture can carry its own color instead of one flat color for
 * the whole cluster (see `uUseTextureColor` in `STAMP_FS`, which decides
 * whether to read this RGB or the brush's).
 *
 * `glow` adds a faint halo wider than the sharp core, around it — "soft
 * edges" instead of a hard cutout. It comes from the same color gradient
 * as the core, just softer in alpha; where another blade's core already
 * covers that texel with more alpha, the halo loses (the usual `if (v >
 * buf[idx])`), so the halo only shows up around blades, never over
 * another one's core.
 */
function paintBlade(
  buf: Uint8Array,
  size: number,
  bx: number,
  by: number,
  angle: number,
  len: number,
  halfThick: number,
  taper: number,
  roughness: number,
  curl: number,
  glow: number,
  opacity: number,
  rand: () => number,
  colors?: { r: number; g: number; b: number }[],
) {
  if (len <= 0) return;
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const curlAmount = curl * len * 0.35;
  const glowReach = halfThick * glow * 4;
  const reach = len + halfThick + Math.abs(curlAmount) + glowReach + 2;
  const x0 = Math.max(0, Math.floor(bx - reach));
  const x1 = Math.min(size - 1, Math.ceil(bx + reach));
  const y0 = Math.max(0, Math.floor(by - reach));
  const y1 = Math.min(size - 1, Math.ceil(by + reach));

  const CONTROLS = 10;
  const edgeNoise = Array.from({ length: CONTROLS + 1 }, () => rand() * 2 - 1);
  const noiseAt = (u: number) => {
    const t = u * CONTROLS;
    const i0 = Math.floor(t);
    const i1 = Math.min(CONTROLS, i0 + 1);
    const f = t - i0;
    return edgeNoise[i0] * (1 - f) + edgeNoise[i1] * f;
  };

  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = x - bx;
      const dy = y - by;
      // Coordinates local to the blade's axis (0 at the base, `len` at
      // the tip) and perpendicular to it.
      const along = dx * c + dy * s;
      if (along < -1 || along > len + 1) continue;
      const perp = -dx * s + dy * c;
      const u = Math.min(1, Math.max(0, along / len));

      const tipTaper = 1 - taper * smoothstep(0.4, 1, u);
      // Starts thin from the base, like a real blade — without this the
      // start looks cut off flat, a rectangle with a point.
      const baseTaper = smoothstep(0, 0.1, u);
      const wobble = 1 + noiseAt(u) * roughness * 0.5;
      const halfThickHere = Math.max(0.4, halfThick * tipTaper * Math.max(0.12, baseTaper) * wobble);

      const bow = curlAmount * Math.sin(u * Math.PI);
      const lenFalloff = along < 0 ? 0 : 1 - smoothstep(len * 0.85, len, along);
      const distFromAxis = Math.abs(perp - bow);
      const edge = distFromAxis - halfThickHere;
      const edgeAlpha = 1 - smoothstep(-1, 1, edge);
      const coreAlpha = Math.min(1, Math.max(0, edgeAlpha * lenFalloff)) * opacity;

      let a = coreAlpha;
      if (glow > 0) {
        const glowOuter = halfThickHere + Math.max(1, glowReach);
        const glowAlpha = Math.max(0, 1 - smoothstep(halfThickHere, glowOuter, distFromAxis)) * glow * 0.55 * lenFalloff * opacity;
        a = Math.max(a, glowAlpha);
      }

      const idx = (y * size + x) * 4 + 3;
      const v = Math.round(a * 255);
      if (v > buf[idx]) {
        buf[idx] = v;
        if (colors && colors.length > 0) {
          const px = lerpColorStops(colors, u);
          buf[idx - 3] = px.r;
          buf[idx - 2] = px.g;
          buf[idx - 1] = px.b;
        }
      }
    }
  }
}

/**
 * Cluster/tuft: several blades (a blade of grass, a leaf, a hair) within
 * the SAME texture, each with its own position, angle, and length —
 * unlike "Generate streak" (a single mark per texture) or `angleJitter`
 * (which scatters orientation between SUCCESSIVE stamps of a drag), here
 * a single stamp is already the whole tuft, the same way "Splatter"
 * already puts several blots in one frame — no dragging needed for it to
 * show.
 */
export interface ClusterTextureParams {
  seed: number;
  count: number;
  /** 0..1: each blade's length, as a fraction of the canvas. */
  bladeLength: number;
  /** 0..1: how much length varies from one blade to the next. */
  lengthVariation: number;
  /** 0..1: each blade's thickness. */
  thickness: number;
  /** 0..1: how much it tapers toward the tip. */
  taper: number;
  /** 0..1: roughness of each blade's edge. */
  roughness: number;
  /** 0..1: how much the bases spread across the canvas — little gives a
   *  tight tuft, a lot gives a clump that fills nearly the whole frame. */
  spread: number;
  /** 0..1: how much each blade's angle varies from "straight up". */
  angleSpread: number;
  opacity: number;
  /**
   * "scatter" (grass, leaves): each blade's position and angle random,
   * the way real vegetation actually sprouts. "parallel" (hair): bases
   * spread out in a row and angle nearly identical between blades — hair
   * doesn't grow every which way, a tuft combs in one direction. The real
   * reference (hair brushes in Photoshop/Procreate) builds the tuft with
   * parallel blades plus a handful of "flyaways" that break the
   * uniformity; without that it looks like a plastic comb. Defaults to
   * "scatter" so textures created before this field wasn't around don't
   * change.
   */
  layout?: 'scatter' | 'parallel';
  /** 0..1: arc curl of each blade — nothing real is a straight line. */
  curl?: number;
  /**
   * Up to 3 colors (0..255 per channel), as gradient stops (see
   * `lerpColorStops`) from each blade's BASE to its TIP — real fire is
   * nearly white where it's hottest and cools toward the tip; even
   * hand-painted hair usually has a darker base. With 1 color, it comes
   * out flat; with 2 or 3, each blade goes from one to the next along its
   * own length, not a fixed color per blade. Absent or empty: no color of
   * its own, each blade comes out white and the brush tints it with its
   * active color (the usual behavior).
   */
  colors?: { r: number; g: number; b: number }[];
  /** 0..1: faint halo around each blade, wider than the sharp core —
   *  soft edges instead of a hard cutout. Meant for fire/light: pair it
   *  with a layer in "Screen" or "Add" blend mode for it to actually
   *  glow over a dark background (see `BLEND_LABELS` in types.ts) — this
   *  only draws the halo, it doesn't make it emit light on its own,
   *  that's the layer's blend mode, not the texture. */
  glow?: number;
  /** How many loose specks (sparks) to scatter above the tips — 0
   *  disables it. Reuses `paintDot`, with the color of the stop nearest
   *  the tip if `colors` is set. */
  sparks?: number;
  /** Radians: the direction blades grow in, measured like in
   *  `paintBlade` (0 = toward +X, -PI/2 = upward). Defaults to -PI/2
   *  (grass/leaves/fire/hair, growing "from the ground up"). Fur uses 0
   *  (horizontal) — not because fur "grows sideways", but because this
   *  texture gets used by dragging the brush, and the texture's
   *  horizontal axis is the one that aligns with the stroke direction. */
  baseAngle?: number;
}

export function generateClusterTexturePixels(
  params: ClusterTextureParams,
  size = BRUSH_TEXTURE_SIZE,
): Uint8Array {
  const buf = new Uint8Array(size * size * 4);
  for (let i = 0; i < buf.length; i += 4) {
    buf[i] = 255;
    buf[i + 1] = 255;
    buf[i + 2] = 255;
    buf[i + 3] = 0;
  }
  const rand = mulberry32(params.seed);
  const count = Math.max(1, Math.round(params.count));
  const parallel = params.layout === 'parallel';
  const curl = params.curl ?? 0;
  const glow = params.glow ?? 0;
  const colors = params.colors;
  const baseAngle = params.baseAngle ?? -Math.PI / 2;
  // Bases spread along the line perpendicular to `baseAngle`, near the
  // edge opposite to where they grow — for the usual grass (growing up)
  // that's near the bottom edge, as before. `dir` is where they grow
  // toward; `perp` is the axis they spread along.
  const dirX = Math.cos(baseAngle);
  const dirY = Math.sin(baseAngle);
  const perpX = -dirY;
  const perpY = dirX;
  const originX = size / 2 - dirX * size * 0.4;
  const originY = size / 2 - dirY * size * 0.4;
  let minTipY = originY;

  for (let i = 0; i < count; i++) {
    // "parallel": spreads the bases in a row (like a comb) instead of at
    // random, and only lets the angle deviate a small fraction of the
    // requested spread — except for an occasional loose blade (flyaway),
    // which does take the full range, just like a real stray hair.
    const t = count === 1 ? 0 : (i / (count - 1)) * 2 - 1;
    const spreadJitter = parallel ? (rand() * 2 - 1) * size * 0.015 : 0;
    const spreadOffset = parallel
      ? t * size * 0.5 * params.spread + spreadJitter
      : (rand() * 2 - 1) * size * 0.5 * params.spread;
    const alongJitter = rand() * size * 0.05;
    const bx = originX + perpX * spreadOffset + dirX * alongJitter;
    const by = originY + perpY * spreadOffset + dirY * alongJitter;
    const len = size * 0.5 * params.bladeLength * (1 + (rand() * 2 - 1) * params.lengthVariation);
    const isFlyaway = parallel && rand() < 0.12;
    const angleSpreadHere = parallel && !isFlyaway ? params.angleSpread * 0.2 : params.angleSpread;
    const angle = baseAngle + (rand() * 2 - 1) * (Math.PI / 2) * angleSpreadHere;
    const halfThick = Math.max(0.5, (size * params.thickness) / 2);
    const curlHere = (rand() * 2 - 1) * curl;
    paintBlade(buf, size, bx, by, angle, len, halfThick, params.taper, params.roughness, curlHere, glow, params.opacity, rand, colors);
    // Approximate tip — only used for sparks, meant for the vertical case
    // (fire); with other directions it's still a reasonable approximation
    // of "where the tips poke out".
    minTipY = Math.min(minTipY, by + dirY * len);
  }

  const sparks = params.sparks ?? 0;
  if (sparks > 0) {
    const sparkColor = colors && colors.length > 0 ? colors[colors.length - 1] : undefined;
    const sparkCount = Math.round(sparks * 10);
    for (let i = 0; i < sparkCount; i++) {
      const sx = size / 2 + (rand() * 2 - 1) * size * 0.5 * Math.max(0.3, params.spread);
      // Above the tips, more likely near them than far away — a spark
      // that's broken loose and is still rising.
      const sy = minTipY - rand() * rand() * size * 0.35;
      const r = size * (0.01 + rand() * 0.015);
      paintDot(buf, size, sx, sy, r, 0.7 + rand() * 0.3, sparkColor);
    }
  }

  return buf;
}
