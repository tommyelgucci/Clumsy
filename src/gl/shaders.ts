/**
 * GLSL ES 3.00 sources for the compositing renderer (task 2.2).
 *
 * Coordinate convention across the whole engine (same as Trace):
 *   - Document space is Y-down, origin top-left.
 *   - A texture's row 0 is v=0, i.e. v=0 is the TOP edge. Rendering to an
 *     FBO gets that for free (clip.y = y/H*2-1), so the only flip in the
 *     whole pipeline happens in the pass to the screen.
 *   - All color travels alpha-premultiplied (see CLAUDE.md).
 *
 * Trimmed from Trace's shaders.ts on purpose: no brush-stamp shader (that's
 * stroke drawing, not in 2.2's scope), no mesh skinning, no HSV adjustment
 * layer, no pigment-mix stroke blending, no selection marching-ants — none
 * of those exist in Clumsyloop's v1 `document.ts` yet. `QUAD_VS` and
 * `COMPOSITE_FS` port close to verbatim since the compositing math itself
 * (the W3C separable blend-mode formulas, premultiplied-alpha compositing)
 * isn't Trace-specific.
 */

/** Generic textured quad: layer compositing and the final screen pass. */
export const QUAD_VS = /* glsl */ `#version 300 es
precision highp float;

layout(location = 0) in vec2 aCorner;  // 0..1

uniform mat3 uMatrix;     // corner -> destination pixels
uniform vec2 uResolution; // destination size in pixels
uniform float uFlipY;     // 1.0 when drawing to the screen, 0.0 into an FBO

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
 * Layer-over-backdrop compositing with the W3C separable blend modes.
 * Indices match `BLEND_INDEX` in `core/types.ts`.
 *
 * The backdrop is a texture rather than `gl.blendFunc` because non-normal
 * modes need to read the destination, and WebGL2 has no framebuffer fetch.
 */
export const COMPOSITE_FS = /* glsl */ `#version 300 es
precision highp float;

in vec2 vUV;

uniform sampler2D uSource;    // premultiplied
uniform sampler2D uBackdrop;  // premultiplied
uniform float uOpacity;
uniform int uBlend;
uniform float uClip;          // 1.0 = clip to the backdrop's alpha
uniform vec4 uTint;           // rgb + strength; used for onion skinning

out vec4 fragColor;

vec3 unpremul(vec4 c) { return c.a > 0.0 ? c.rgb / c.a : vec3(0.0); }

float blendChannel(int mode, float cb, float cs) {
  if (mode == 1) return cb * cs;                                   // multiply
  if (mode == 2) return cb + cs - cb * cs;                         // screen
  if (mode == 3) return cb <= 0.5 ? 2.0 * cb * cs                  // overlay
                                  : 1.0 - 2.0 * (1.0 - cb) * (1.0 - cs);
  if (mode == 4) return min(cb, cs);                               // darken
  if (mode == 5) return max(cb, cs);                               // lighten
  if (mode == 6) return cs >= 1.0 ? 1.0 : min(1.0, cb / (1.0 - cs));   // colorDodge
  if (mode == 7) return cs <= 0.0 ? 0.0 : 1.0 - min(1.0, (1.0 - cb) / cs); // colorBurn
  if (mode == 8) return cs <= 0.5 ? 2.0 * cs * cb                  // hardLight
                                  : 1.0 - 2.0 * (1.0 - cs) * (1.0 - cb);
  if (mode == 9) {                                                 // softLight
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

  cs = mix(cs, uTint.rgb, uTint.a);

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

/** Final pass: transparency checkerboard + paper, under the composited document. */
export const PRESENT_FS = /* glsl */ `#version 300 es
precision highp float;

in vec2 vUV;

uniform sampler2D uSource;
uniform vec2 uDocSize;
uniform float uCheckerScale;  // checker cell size, in document pixels
uniform vec3 uPaper;          // paper color under the document
uniform float uPaperAlpha;    // 0 = show checkerboard, 1 = opaque paper

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
