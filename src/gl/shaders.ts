/**
 * GLSL ES 3.00 sources for the renderer.
 *
 * Coordinate convention across the engine:
 *   - Document space is Y-down, origin top-left.
 *   - Textures store row 0 at v=0, i.e. v=0 is the TOP edge. Rendering to
 *     an FBO gets that for free (clip.y = y/H*2-1), so the pipeline's only
 *     flip happens in the screen pass.
 *   - All color travels alpha-premultiplied.
 *
 * Ported from Trace (`gl/shaders.ts`, same owner) — see CLAUDE.md. Trimmed
 * to what task 2.2 needs: stamping (brush strokes), quad-based layer
 * compositing, and the final present pass. Left out on purpose, not by
 * oversight, since nothing in Clumsyloop's v1 scope uses them yet: MIX_FS
 * (pigment-mix wet blending — one ported brush preset references it via
 * `pigmentMix`, but live stroke merging is the future drawing UI's job,
 * not this renderer), SKIN_VS (bone rig, no `core/rig.ts` here),
 * ADJUST_FS (adjustment layers, not in `document.ts`), and ANTS_FS
 * (selection marching ants, no `core/selection.ts` here).
 */

/** Brush stamps, drawn with `drawArraysInstanced`. */
export const STAMP_VS = /* glsl */ `#version 300 es
precision highp float;

// Locations are pinned here: leaving it to the linker would mean querying
// them at runtime and keeping the VAO in sync by hand.
layout(location = 0) in vec2 aCorner;    // unit quad corner, 0..1
layout(location = 1) in vec2 iPos;       // stamp center, document px
layout(location = 2) in float iSize;     // major diameter, px
layout(location = 3) in float iAngle;    // radians
layout(location = 4) in float iAlpha;    // 0..1
layout(location = 5) in float iHardness; // 0..1
layout(location = 6) in float iAspect;   // 0..1, minor-axis flattening

uniform vec2 uResolution;

out vec2 vLocal;      // -1..1 inside the stamp, already circularized
out float vAlpha;
out float vHardness;

void main() {
  vec2 unit = aCorner * 2.0 - 1.0;
  float r = iSize * 0.5;
  vec2 scaled = vec2(unit.x * r, unit.y * r * iAspect);

  float c = cos(iAngle);
  float s = sin(iAngle);
  vec2 rotated = vec2(scaled.x * c - scaled.y * s, scaled.x * s + scaled.y * c);

  vec2 pos = iPos + rotated;
  gl_Position = vec4((pos / uResolution) * 2.0 - 1.0, 0.0, 1.0);

  // The fragment shader measures distance in circular space, not the
  // flattened one, so an elliptical brush doesn't get a deformed falloff.
  vLocal = unit;
  vAlpha = iAlpha;
  vHardness = iHardness;
}
`;

export const STAMP_FS = /* glsl */ `#version 300 es
precision highp float;

in vec2 vLocal;
in float vAlpha;
in float vHardness;

uniform vec3 uColor;      // straight sRGB, 0..1
uniform float uUseTexture;
// Separate from uUseTexture (whether the texture supplies SHAPE) — some
// textures (the cluster generator, with per-strand shadow/base/highlight)
// also supply COLOR: see CustomTexture.hasColor in brushTexture.ts.
uniform float uUseTextureColor;
uniform sampler2D uTexture;

out vec4 fragColor;

void main() {
  float d = length(vLocal);
  if (d > 1.0) discard;

  // hardness=1 leaves ~1.5px of antialiasing at the edge; at 0 the
  // gradient spans the whole radius.
  float inner = vHardness * 0.98;
  float coverage = 1.0 - smoothstep(inner, 1.0, d);

  vec3 color = uColor;
  if (uUseTexture > 0.5) {
    vec4 tex = texture(uTexture, vLocal * 0.5 + 0.5);
    coverage *= tex.a;
    if (uUseTextureColor > 0.5) color = tex.rgb;
  }

  float a = coverage * vAlpha;
  fragColor = vec4(color * a, a);   // premultiplied
}
`;

/** Generic textured quad: layer compositing and the final present pass. */
export const QUAD_VS = /* glsl */ `#version 300 es
precision highp float;

layout(location = 0) in vec2 aCorner;  // 0..1

uniform mat3 uMatrix;     // corner -> destination pixels
uniform vec2 uResolution; // destination size, pixels
uniform float uFlipY;     // 1.0 when drawing to screen, 0.0 into an FBO

out vec2 vUV;

void main() {
  vec3 p = uMatrix * vec3(aCorner, 1.0);
  vec2 ndc = (p.xy / uResolution) * 2.0 - 1.0;
  if (uFlipY > 0.5) ndc.y = -ndc.y;
  gl_Position = vec4(ndc, 0.0, 1.0);
  vUV = aCorner;
}
`;

/**
 * Layer-over-backdrop compositing with the W3C compositing spec's
 * separable blend modes.
 *
 * The backdrop is passed as a texture instead of using `gl.blendFunc`
 * because the non-normal modes need to read the destination, and WebGL2
 * doesn't expose framebuffer fetch.
 */
export const COMPOSITE_FS = /* glsl */ `#version 300 es
precision highp float;

in vec2 vUV;

uniform sampler2D uSource;    // premultiplied
uniform sampler2D uBackdrop;  // premultiplied
uniform float uOpacity;
uniform int uBlend;
uniform float uClip;          // 1.0 = clip to the backdrop's alpha

out vec4 fragColor;

vec3 unpremul(vec4 c) { return c.a > 0.0 ? c.rgb / c.a : vec3(0.0); }

float blendChannel(int mode, float cb, float cs) {
  if (mode == 1) return cb * cs;                                   // multiply
  if (mode == 2) return cb + cs - cb * cs;                         // screen
  if (mode == 3) return cb <= 0.5 ? 2.0 * cb * cs                  // overlay
                                  : 1.0 - 2.0 * (1.0 - cb) * (1.0 - cs);
  if (mode == 4) return min(cb, cs);                               // darken
  if (mode == 5) return max(cb, cs);                               // lighten
  if (mode == 6) return cs >= 1.0 ? 1.0 : min(1.0, cb / (1.0 - cs));   // dodge
  if (mode == 7) return cs <= 0.0 ? 0.0 : 1.0 - min(1.0, (1.0 - cb) / cs); // burn
  if (mode == 8) return cs <= 0.5 ? 2.0 * cs * cb                  // hard-light
                                  : 1.0 - 2.0 * (1.0 - cs) * (1.0 - cb);
  if (mode == 9) {                                                 // soft-light
    float d = cb <= 0.25 ? ((16.0 * cb - 12.0) * cb + 4.0) * cb : sqrt(cb);
    return cs <= 0.5 ? cb - (1.0 - 2.0 * cs) * cb * (1.0 - cb)
                     : cb + (2.0 * cs - 1.0) * (d - cb);
  }
  if (mode == 10) return abs(cb - cs);                             // difference
  if (mode == 11) return cb + cs - 2.0 * cb * cs;                  // exclusion
  if (mode == 12) return min(1.0, cb + cs);                        // add
  return cs;                                                       // normal
}

void main() {
  vec4 src = texture(uSource, vUV);
  vec4 bd = texture(uBackdrop, vUV);

  float as = src.a * uOpacity;
  if (uClip > 0.5) as *= bd.a;

  vec3 cs = unpremul(src);
  vec3 cb = unpremul(bd);

  vec3 blended = vec3(
    blendChannel(uBlend, cb.r, cs.r),
    blendChannel(uBlend, cb.g, cs.g),
    blendChannel(uBlend, cb.b, cs.b)
  );

  // Standard formula: the blend result only shows where there's backdrop.
  vec3 co = as * (1.0 - bd.a) * cs + as * bd.a * blended + (1.0 - as) * bd.a * cb;
  float ao = as + bd.a * (1.0 - as);

  fragColor = vec4(co, ao);
}
`;

/**
 * Straight premultiplied copy, with optional opacity.
 *
 * No mask uniform — unlike Trace, Clumsyloop has no `core/selection.ts`
 * yet, so there's nothing to clip a copy against in v1.
 */
export const COPY_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUV;
uniform sampler2D uSource;
uniform float uOpacity;
out vec4 fragColor;
void main() {
  fragColor = texture(uSource, vUV) * uOpacity;
}
`;

/** Final pass: transparency checkerboard + document, with the paper color. */
export const PRESENT_FS = /* glsl */ `#version 300 es
precision highp float;

in vec2 vUV;

uniform sampler2D uSource;
uniform vec2 uDocSize;
uniform float uCheckerScale;  // checker cell size, document px
uniform vec3 uPaper;          // paper color under the document
uniform float uPaperAlpha;    // 0 = show checker, 1 = opaque paper

out vec4 fragColor;

void main() {
  vec4 src = texture(uSource, vUV);

  vec2 cell = floor(vUV * uDocSize / uCheckerScale);
  float checker = mod(cell.x + cell.y, 2.0) < 0.5 ? 0.22 : 0.28;
  vec3 under = mix(vec3(checker), uPaper, uPaperAlpha);

  vec3 outColor = src.rgb + under * (1.0 - src.a);
  fragColor = vec4(outColor, 1.0);
}
`;
