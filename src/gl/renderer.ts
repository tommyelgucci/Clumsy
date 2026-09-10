/**
 * WebGL2 renderer (task 2.2): compositing camera frame + drawn layers.
 *
 * Ported from Trace's `gl/renderer.ts` (same owner, same pattern — see
 * CLAUDE.md), trimmed hard to what Clumsyloop's v1 document model
 * (`core/document.ts`) actually uses. Left out on purpose, not by
 * oversight, because nothing in `document.ts` needs them yet:
 *
 * - No GPU texture residency budget/eviction/CPU backing. Trace counts
 *   texture bytes because a rig-heavy project can have dozens of
 *   surfaces alive on an iPad. Clumsyloop's real memory question is
 *   different: a stop-motion project is "hundreds of photos" (RUMBO.md),
 *   each a full-document-sized camera Cel. That's a genuine v1 concern,
 *   but building an eviction pool now, before the capture UI (task 2.3)
 *   exists to generate real frame counts to profile against, would be
 *   guessing at a solution before the shape of the problem is known.
 *   Flagged here so it isn't lost — likely lands in 2.3 or 2.4.
 * - No mesh skinning (`drawSkinned`) — no `core/rig.ts`, no bone rigs in
 *   v1 scope.
 * - No adjustment-layer pass (`applyAdjustment`) — `document.ts` has no
 *   `AdjustmentProps`.
 * - No selection outline (`drawSelectionOutline`) — no `core/selection.ts`.
 * - No pigment-mix pass (`mixOver`). One ported `brush.ts` preset
 *   ("Watercolor") sets `pigmentMix: 0.15`, but *live* wet-stroke merging
 *   is the future drawing UI's job, not this renderer — `drawStamps`
 *   still paints that preset's stamps correctly, just without the
 *   subtractive-mix blending pass on merge.
 * - No thumbnail downscaling (`downscaleToCanvas`) — task 2.3 ("filmstrip
 *   thumbnail strip") is the first thing that needs it; building it here
 *   with no caller to verify against isn't worth the risk of getting the
 *   ink-bounds cropping subtly wrong unnoticed.
 *
 * What's NOT trimmed, on purpose: all 13 `BlendMode`s (`composite`) and
 * brush stamping (`drawStamps`) — `types.ts` and `brush.ts` already
 * commit to the full set, so the shader has to honor it.
 */
import { COMPOSITE_FS, COPY_FS, PRESENT_FS, QUAD_VS, STAMP_FS, STAMP_VS } from './shaders';
import {
  buildClipGroups,
  celAt,
  sampleChannel,
  transformIsIdentity,
  type ClumsyloopDocument,
  type Layer,
} from '../core/document';
import { mat3FromTRS, mat3Identity, mat3Multiply, type Mat3 } from '../core/math';
import { BLEND_INDEX, type RGB, type Stamp } from '../core/types';

/**
 * A surface is a document-sized, alpha-premultiplied RGBA8 texture with
 * its FBO. Unlike Trace, there's no CPU-backed eviction here (see the
 * file header) — a Surface's GPU resources live for as long as the
 * object does. `version` bumps on every write; it's what will invalidate
 * a thumbnail cache once one exists.
 */
export class Surface {
  tex: WebGLTexture | null = null;
  fbo: WebGLFramebuffer | null = null;
  /** true until the first write — lets callers skip compositing empty layers. */
  empty = true;
  version = 0;
  readonly label: string;

  constructor(label: string) {
    this.label = label;
  }
}

export interface CompositeOptions {
  opacity: number;
  blend: number;
  /** Clip to the backdrop's alpha — how `Layer.clipToBelow` is realized. */
  clip?: boolean;
}

interface ProgramInfo {
  program: WebGLProgram;
  uniforms: Record<string, WebGLUniformLocation | null>;
}

export class Renderer {
  readonly canvas: HTMLCanvasElement;
  readonly gl: WebGL2RenderingContext;
  docWidth = 0;
  docHeight = 0;

  private programs = new Map<string, ProgramInfo>();
  private quadVAO!: WebGLVertexArrayObject;
  private stampVAO!: WebGLVertexArrayObject;
  private stampBuffer!: WebGLBuffer;
  private stampData = new Float32Array(0);

  private scratches = new Map<string, Surface>();
  /** Brush-tip masks, generated or uploaded once and cached by id
   *  (built-in texture id, or a future `CustomTexture.id`) — they don't
   *  depend on document size, so they survive `setDocumentSize`. */
  private brushTextures = new Map<string, WebGLTexture>();
  private brushTextureHasColor = new Map<WebGLTexture, boolean>();

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: true,
      preserveDrawingBuffer: false,
      desynchronized: true,
      powerPreference: 'high-performance',
    });
    if (!gl) throw new Error('WebGL2 is not available in this browser.');
    this.gl = gl;

    this.buildPrograms();
    this.buildGeometry();
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.DITHER);
  }

  /* ---------------------------------------------------------------- *
   * Programs and geometry
   * ---------------------------------------------------------------- */

  private compile(type: number, src: string): WebGLShader {
    const gl = this.gl;
    const sh = gl.createShader(type)!;
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(sh);
      gl.deleteShader(sh);
      throw new Error(`Shader compile error: ${log}`);
    }
    return sh;
  }

  private link(name: string, vs: string, fs: string, uniforms: string[]) {
    const gl = this.gl;
    const program = gl.createProgram()!;
    const v = this.compile(gl.VERTEX_SHADER, vs);
    const f = this.compile(gl.FRAGMENT_SHADER, fs);
    gl.attachShader(program, v);
    gl.attachShader(program, f);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(`Link error in ${name}: ${gl.getProgramInfoLog(program)}`);
    }
    gl.deleteShader(v);
    gl.deleteShader(f);
    const locs: Record<string, WebGLUniformLocation | null> = {};
    for (const u of uniforms) locs[u] = gl.getUniformLocation(program, u);
    this.programs.set(name, { program, uniforms: locs });
  }

  private buildPrograms() {
    this.link('stamp', STAMP_VS, STAMP_FS, [
      'uResolution',
      'uColor',
      'uUseTexture',
      'uUseTextureColor',
      'uTexture',
    ]);
    this.link('composite', QUAD_VS, COMPOSITE_FS, [
      'uMatrix',
      'uResolution',
      'uFlipY',
      'uSource',
      'uBackdrop',
      'uOpacity',
      'uBlend',
      'uClip',
    ]);
    this.link('copy', QUAD_VS, COPY_FS, ['uMatrix', 'uResolution', 'uFlipY', 'uSource', 'uOpacity']);
    this.link('present', QUAD_VS, PRESENT_FS, [
      'uMatrix',
      'uResolution',
      'uFlipY',
      'uSource',
      'uDocSize',
      'uCheckerScale',
      'uPaper',
      'uPaperAlpha',
    ]);
  }

  private buildGeometry() {
    const gl = this.gl;
    const corners = new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]);

    const cornerBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, cornerBuf);
    gl.bufferData(gl.ARRAY_BUFFER, corners, gl.STATIC_DRAW);

    this.quadVAO = gl.createVertexArray()!;
    gl.bindVertexArray(this.quadVAO);
    gl.bindBuffer(gl.ARRAY_BUFFER, cornerBuf);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    this.stampVAO = gl.createVertexArray()!;
    gl.bindVertexArray(this.stampVAO);
    gl.bindBuffer(gl.ARRAY_BUFFER, cornerBuf);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    this.stampBuffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.stampBuffer);
    // iPos(2) iSize iAngle iAlpha iHardness iAspect = 7 floats
    const stride = 7 * 4;
    const layout: [number, number, number][] = [
      [1, 2, 0], // iPos
      [2, 1, 8], // iSize
      [3, 1, 12], // iAngle
      [4, 1, 16], // iAlpha
      [5, 1, 20], // iHardness
      [6, 1, 24], // iAspect
    ];
    for (const [loc, size, offset] of layout) {
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride, offset);
      gl.vertexAttribDivisor(loc, 1);
    }
    gl.bindVertexArray(null);
  }

  /* ---------------------------------------------------------------- *
   * Surface lifecycle
   * ---------------------------------------------------------------- */

  /**
   * Sets the document size every surface this renderer creates is sized
   * to. Cheap to call repeatedly (early-returns once already set) — a
   * document's width/height are fixed for its lifetime (`newDocument`),
   * so this only actually runs once per document. Changing size after
   * cels already exist isn't supported: their surfaces stay at the old
   * size, mismatched with new ones — out of v1 scope (no canvas-resize
   * UI exists).
   */
  setDocumentSize(w: number, h: number) {
    if (w === this.docWidth && h === this.docHeight) return;
    this.docWidth = w;
    this.docHeight = h;
    for (const s of this.scratches.values()) this.release(s);
    this.scratches.clear();
  }

  /** A new document-sized surface, cleared to transparent. */
  createSurface(label = 'cel'): Surface {
    const s = new Surface(label);
    this.allocate(s);
    return s;
  }

  private allocate(s: Surface) {
    const gl = this.gl;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, this.docWidth, this.docHeight);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    const fbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    s.tex = tex;
    s.fbo = fbo;
  }

  /** Frees a surface's GPU resources. Safe to call more than once. */
  release(s: Surface) {
    if (!s.tex) return;
    this.gl.deleteFramebuffer(s.fbo);
    this.gl.deleteTexture(s.tex);
    s.tex = null;
    s.fbo = null;
  }

  /** Reusable working surface, keyed by name — created lazily, kept for
   *  the renderer's lifetime (or until `setDocumentSize` changes size). */
  scratch(name: string): Surface {
    let s = this.scratches.get(name);
    if (!s) {
      s = this.createSurface(`scratch:${name}`);
      this.scratches.set(name, s);
    }
    return s;
  }

  clear(s: Surface) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, s.fbo);
    gl.disable(gl.BLEND);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    s.empty = true;
    s.version++;
  }

  fill(s: Surface, color: RGB, alpha: number) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, s.fbo);
    gl.disable(gl.BLEND);
    gl.clearColor(color.r * alpha, color.g * alpha, color.b * alpha, alpha);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    s.empty = alpha === 0;
    s.version++;
  }

  /* ---------------------------------------------------------------- *
   * Drawing
   * ---------------------------------------------------------------- */

  /** Brush-tip mask texture, generated/uploaded once per id and cached
   *  after. `resolvePixels` only runs on a cache miss. */
  getBrushTexture(id: string, resolvePixels: () => { pixels: Uint8Array; hasColor: boolean }): WebGLTexture {
    const cached = this.brushTextures.get(id);
    if (cached) return cached;

    const gl = this.gl;
    const size = 128;
    const { pixels, hasColor } = resolvePixels();

    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, size, size);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, size, size, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    this.brushTextures.set(id, tex);
    this.brushTextureHasColor.set(tex, hasColor);
    return tex;
  }

  /**
   * Stamps a batch of brush points onto `target`. Every stamp in a
   * segment goes in one instanced draw call.
   */
  drawStamps(target: Surface, stamps: Stamp[], color: RGB, brushTexture?: WebGLTexture, erase = false) {
    if (stamps.length === 0) return;
    const gl = this.gl;

    const needed = stamps.length * 7;
    if (this.stampData.length < needed) {
      this.stampData = new Float32Array(Math.max(needed, this.stampData.length * 2, 1024));
    }
    const data = this.stampData;
    for (let i = 0; i < stamps.length; i++) {
      const s = stamps[i];
      const o = i * 7;
      data[o] = s.x;
      data[o + 1] = s.y;
      data[o + 2] = s.size;
      data[o + 3] = s.angle;
      data[o + 4] = s.alpha;
      data[o + 5] = s.hardness;
      data[o + 6] = s.aspect;
    }

    const p = this.programs.get('stamp')!;
    gl.useProgram(p.program);
    gl.bindVertexArray(this.stampVAO);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.stampBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, data.subarray(0, needed), gl.DYNAMIC_DRAW);

    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
    gl.viewport(0, 0, this.docWidth, this.docHeight);
    gl.enable(gl.BLEND);
    // Erase brushes (brush.ts's 'eraser' category) subtract coverage from
    // the destination instead of laying down ink — same trick as Trace's
    // drawOver: the shader's RGB output is irrelevant here since ZERO
    // drops it, only the stamp's alpha shapes how much gets erased.
    if (erase) gl.blendFunc(gl.ZERO, gl.ONE_MINUS_SRC_ALPHA);
    else gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    gl.uniform2f(p.uniforms.uResolution, this.docWidth, this.docHeight);
    gl.uniform3f(p.uniforms.uColor, color.r, color.g, color.b);
    gl.uniform1f(p.uniforms.uUseTexture, brushTexture ? 1 : 0);
    const useTextureColor = brushTexture ? (this.brushTextureHasColor.get(brushTexture) ?? false) : false;
    gl.uniform1f(p.uniforms.uUseTextureColor, useTextureColor ? 1 : 0);
    // Unit 0 always gets touched, even with no texture: leaving whatever
    // was bound before risks it being `target`'s own texture (e.g. a
    // previous stroke segment on the same cel), and WebGL2 rejects the
    // whole draw call as a framebuffer/texture feedback loop even if the
    // shader never samples it.
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, brushTexture ?? null);
    if (brushTexture) gl.uniform1i(p.uniforms.uTexture, 0);

    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, stamps.length);

    gl.bindVertexArray(null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    target.empty = false;
    target.version++;
  }

  /** Full-document matrix for the unit quad (`docMatrix() * corner = doc pixels`). */
  private docMatrix(): Mat3 {
    return mat3FromTRS(0, 0, 0, this.docWidth, this.docHeight);
  }

  /** `dst = src` (with opacity), overwriting the destination. */
  copy(dst: Surface, src: Surface, opacity = 1, matrix?: Mat3) {
    const gl = this.gl;
    const p = this.programs.get('copy')!;
    gl.useProgram(p.program);
    gl.bindVertexArray(this.quadVAO);
    gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fbo);
    gl.viewport(0, 0, this.docWidth, this.docHeight);
    gl.disable(gl.BLEND);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.uniformMatrix3fv(p.uniforms.uMatrix, false, matrix ?? this.docMatrix());
    gl.uniform2f(p.uniforms.uResolution, this.docWidth, this.docHeight);
    gl.uniform1f(p.uniforms.uFlipY, 0);
    gl.uniform1f(p.uniforms.uOpacity, opacity);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, src.tex);
    gl.uniform1i(p.uniforms.uSource, 0);

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    dst.empty = src.empty;
    dst.version++;
  }

  /** Draws `src` on top of whatever is already in `dst`, plain src-over. */
  drawOver(dst: Surface, src: Surface, opacity = 1, matrix?: Mat3) {
    const gl = this.gl;
    const p = this.programs.get('copy')!;
    gl.useProgram(p.program);
    gl.bindVertexArray(this.quadVAO);
    gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fbo);
    gl.viewport(0, 0, this.docWidth, this.docHeight);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    gl.uniformMatrix3fv(p.uniforms.uMatrix, false, matrix ?? this.docMatrix());
    gl.uniform2f(p.uniforms.uResolution, this.docWidth, this.docHeight);
    gl.uniform1f(p.uniforms.uFlipY, 0);
    gl.uniform1f(p.uniforms.uOpacity, opacity);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, src.tex);
    gl.uniform1i(p.uniforms.uSource, 0);

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (!src.empty) dst.empty = false;
    dst.version++;
  }

  /**
   * `dst = blend(backdrop, src)`. Needs three distinct surfaces because
   * WebGL2 doesn't allow reading and writing the same texture in one pass.
   */
  composite(dst: Surface, backdrop: Surface, src: Surface, opts: CompositeOptions) {
    const gl = this.gl;
    const p = this.programs.get('composite')!;
    gl.useProgram(p.program);
    gl.bindVertexArray(this.quadVAO);
    gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fbo);
    gl.viewport(0, 0, this.docWidth, this.docHeight);
    gl.disable(gl.BLEND);

    gl.uniformMatrix3fv(p.uniforms.uMatrix, false, this.docMatrix());
    gl.uniform2f(p.uniforms.uResolution, this.docWidth, this.docHeight);
    gl.uniform1f(p.uniforms.uFlipY, 0);
    gl.uniform1f(p.uniforms.uOpacity, opts.opacity);
    gl.uniform1i(p.uniforms.uBlend, opts.blend);
    gl.uniform1f(p.uniforms.uClip, opts.clip ? 1 : 0);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, src.tex);
    gl.uniform1i(p.uniforms.uSource, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, backdrop.tex);
    gl.uniform1i(p.uniforms.uBackdrop, 1);

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    dst.empty = backdrop.empty && src.empty;
    dst.version++;
  }

  /** Final pass to the screen, with the view transform and the paper. */
  present(src: Surface, viewMatrix: Mat3, paper: RGB, paperAlpha: number, checkerScale: number) {
    const gl = this.gl;
    const p = this.programs.get('present')!;
    gl.useProgram(p.program);
    gl.bindVertexArray(this.quadVAO);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.disable(gl.BLEND);
    gl.clearColor(0.09, 0.09, 0.1, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.uniformMatrix3fv(p.uniforms.uMatrix, false, viewMatrix);
    gl.uniform2f(p.uniforms.uResolution, this.canvas.width, this.canvas.height);
    gl.uniform1f(p.uniforms.uFlipY, 1);
    gl.uniform2f(p.uniforms.uDocSize, this.docWidth, this.docHeight);
    gl.uniform1f(p.uniforms.uCheckerScale, checkerScale);
    gl.uniform3f(p.uniforms.uPaper, paper.r, paper.g, paper.b);
    gl.uniform1f(p.uniforms.uPaperAlpha, paperAlpha);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, src.tex);
    gl.uniform1i(p.uniforms.uSource, 0);

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);
  }

  /* ---------------------------------------------------------------- *
   * CPU <-> GPU transfer
   * ---------------------------------------------------------------- */

  /** Uploads a decoded image into a surface — how a captured photo
   *  becomes a camera Cel's content. The source must already be sized to
   *  the document (see `setDocumentSize`'s note): this only uploads,
   *  it doesn't scale. */
  uploadImage(s: Surface, source: ImageBitmap | HTMLCanvasElement) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, s.tex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.texSubImage2D(
      gl.TEXTURE_2D,
      0,
      0,
      0,
      Math.min(source.width, this.docWidth),
      Math.min(source.height, this.docHeight),
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      source as unknown as TexImageSource,
    );
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    s.empty = false;
    s.version++;
  }

  /** Uploads raw straight-alpha RGBA8 pixels into a surface — how a
   *  decoded PNG (`core/io.ts`'s `decodeCelPixels`, task 2.5) becomes a
   *  cel's content again on load. Premultiplies in JS rather than
   *  relying on `UNPACK_PREMULTIPLY_ALPHA_WEBGL` the way `uploadImage`
   *  does: that flag is well-specified for an image/canvas source, not
   *  for a raw `ArrayBufferView`, so this doesn't take the risk. Pixels
   *  must already be sized to the document, same caveat as `uploadImage`. */
  uploadPixels(s: Surface, width: number, height: number, straightRGBA: Uint8Array) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, s.tex);
    gl.texSubImage2D(
      gl.TEXTURE_2D,
      0,
      0,
      0,
      Math.min(width, this.docWidth),
      Math.min(height, this.docHeight),
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      premultiply(straightRGBA),
    );
    s.empty = false;
    s.version++;
  }

  readRect(s: Surface, x: number, y: number, w: number, h: number): Uint8Array {
    const gl = this.gl;
    const out = new Uint8Array(w * h * 4);
    if (w <= 0 || h <= 0 || !s.tex) return out;
    gl.bindFramebuffer(gl.FRAMEBUFFER, s.fbo);
    gl.readPixels(x, y, w, h, gl.RGBA, gl.UNSIGNED_BYTE, out);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return out;
  }

  /** Writes already-premultiplied RGBA pixels into a sub-rectangle —
   *  the bucket tool's write-back path (task 2.7): the CPU-side flood
   *  fill only touches a small bounding box, so there's no reason to
   *  re-upload the whole surface. */
  writeRect(s: Surface, x: number, y: number, w: number, h: number, pixels: Uint8Array) {
    if (w <= 0 || h <= 0) return;
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, s.tex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, x, y, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    s.empty = false;
    s.version++;
  }

  /** The whole surface as straight-alpha (un-premultiplied) `ImageData` —
   *  what both PNG export and `canvas.putImageData` expect. */
  toImageData(s: Surface): ImageData {
    const px = this.readRect(s, 0, 0, this.docWidth, this.docHeight);
    unpremultiply(px);
    return new ImageData(new Uint8ClampedArray(px.buffer as ArrayBuffer), this.docWidth, this.docHeight);
  }

  identity(): Mat3 {
    return mat3Identity();
  }

  /* ---------------------------------------------------------------- *
   * Document-level composition
   * ---------------------------------------------------------------- */

  /**
   * Composites every visible layer of `doc` at `frame` into a single
   * surface, bottom to top — camera and draw layers alike, since a Cel is
   * "just a Surface" regardless of `Layer.kind` (see `document.ts`'s note
   * on `Cel`). Clip groups (`buildClipGroups`) are resolved against their
   * base layer before the group as a whole reaches the accumulator, same
   * order Trace's `engine.ts` uses, trimmed of the wet-stroke/onion-skin/
   * active-layer caching this renderer doesn't have yet.
   *
   * The returned `Surface` is one of this renderer's own scratch buffers
   * (same convention as Trace's `compositeGroups`) — it's only valid
   * until the next call that touches the accumulator pool, including the
   * next `renderDocumentFrame` call for a different frame. A caller that
   * needs to keep more than one rendered frame around at once (rendering
   * two frames back to back to compare them, encoding a whole clip to
   * export) must `copy()` each result into its own surface right away;
   * holding onto two calls' return values directly aliases the same
   * buffer once their clip-group counts give the ping-pong the same
   * parity — confirmed the hard way once, not a hypothetical caveat.
   */
  renderDocumentFrame(doc: ClumsyloopDocument, frame: number): Surface {
    this.setDocumentSize(doc.width, doc.height);
    const groups = buildClipGroups(doc.layers);

    let acc = this.scratch('acc0');
    let other = this.scratch('acc1');
    if (doc.paperAlpha > 0) this.fill(acc, doc.paper, doc.paperAlpha);
    else this.clear(acc);

    for (const { base, clipped } of groups) {
      if (!base.visible) continue;

      const baseSurface = this.rasterizeLayer(base, doc, frame);
      const visibleClipped = clipped.filter((l) => l.visible);
      if (!baseSurface && visibleClipped.length === 0) continue;

      let source: Surface;
      if (visibleClipped.length === 0 && baseSurface) {
        source = baseSurface;
      } else {
        // Clipped layers resolve against the base in their own scratch
        // pair before the group as a whole touches the accumulator.
        let g = this.scratch('groupA');
        let g2 = this.scratch('groupB');
        if (baseSurface) this.copy(g, baseSurface, 1);
        else this.clear(g);
        for (const child of visibleClipped) {
          const cs = this.rasterizeLayer(child, doc, frame);
          if (!cs) continue;
          this.composite(g2, g, cs, {
            opacity: child.opacity * sampleChannel(child.transform.opacity, frame),
            blend: BLEND_INDEX[child.blend],
            clip: true,
          });
          [g, g2] = [g2, g];
        }
        source = g;
      }

      this.composite(other, acc, source, {
        opacity: base.opacity * sampleChannel(base.transform.opacity, frame),
        blend: BLEND_INDEX[base.blend],
      });
      [acc, other] = [other, acc];
    }
    return acc;
  }

  /** This layer's cel at `frame`, positioned by its `TransformTrack` —
   *  or `null` if it has no cel there. Returns the cel's own surface
   *  untouched when the transform is the identity (the common case), to
   *  avoid an extra copy per frame. */
  private rasterizeLayer(layer: Layer, doc: ClumsyloopDocument, frame: number): Surface | null {
    const cel = celAt(layer, frame);
    if (!cel) return null;
    const src = cel.surface;
    if (transformIsIdentity(layer.transform, frame)) return src;

    const tx = sampleChannel(layer.transform.x, frame);
    const ty = sampleChannel(layer.transform.y, frame);
    const scale = sampleChannel(layer.transform.scale, frame);
    const rot = sampleChannel(layer.transform.rotation, frame);
    const cx = doc.width / 2;
    const cy = doc.height / 2;
    // Rotate/scale about the document's center, then translate — in
    // document-pixel space — composed with the unit-quad-to-document
    // scale `drawOver`'s matrix expects.
    const centerXform = mat3FromTRS(tx, ty, rot, scale, scale, cx, cy);
    const m = mat3Multiply(centerXform, this.docMatrix());

    const out = this.scratch('xf');
    this.clear(out);
    this.drawOver(out, src, 1, m);
    return out;
  }
}

/** Converts premultiplied RGBA to straight alpha, in place. */
function unpremultiply(px: Uint8Array) {
  for (let i = 0; i < px.length; i += 4) {
    const a = px[i + 3];
    if (a !== 0 && a !== 255) {
      const inv = 255 / a;
      px[i] = Math.min(255, px[i] * inv);
      px[i + 1] = Math.min(255, px[i + 1] * inv);
      px[i + 2] = Math.min(255, px[i + 2] * inv);
    }
  }
}

/** Converts straight-alpha RGBA to premultiplied, into a new buffer
 *  (`uploadPixels` needs the input untouched — it may be a caller-owned
 *  `DecodedCel.pixels`). */
function premultiply(px: Uint8Array): Uint8Array {
  const out = new Uint8Array(px.length);
  for (let i = 0; i < px.length; i += 4) {
    const a = px[i + 3];
    out[i] = (px[i] * a) / 255;
    out[i + 1] = (px[i + 1] * a) / 255;
    out[i + 2] = (px[i + 2] * a) / 255;
    out[i + 3] = a;
  }
  return out;
}
