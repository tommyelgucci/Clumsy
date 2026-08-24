/**
 * WebGL2 renderer (task 2.2): uploads a captured photo as a texture and
 * composites it with the drawing layers on top of it, all
 * alpha-premultiplied, with a single Y-flip pass on the way to the screen
 * — same invariants as Trace (see CLAUDE.md).
 *
 * Trimmed from Trace's `gl/renderer.ts` on purpose, matching how
 * `core/document.ts` was trimmed in task 2.1: no brush-stamp drawing (that's
 * stroke input, not compositing — a later task), no texture-residency
 * eviction pool (Trace needs it so a project with hundreds of cels doesn't
 * blow an iPad's memory budget; Clumsyloop doesn't have persistence or
 * hundreds of cels yet — task 2.5 — so every `Surface` just stays GPU
 * -resident for now), no mesh skinning, HSV adjustment layers, pigment-mix
 * stroke blending, or selection outline — none of those exist in this
 * project's v1 `document.ts`. `composite()` ports close to verbatim; it's
 * the actual product logic (W3C blend modes + premultiplied compositing),
 * not Trace-specific.
 */
import { buildClipGroups, celAt, type ClumsyloopDocument } from '../core/document';
import { BLEND_INDEX, type RGB } from '../core/types';
import { COMPOSITE_FS, PRESENT_FS, QUAD_VS } from './shaders';

/**
 * A document-sized RGBA8 texture + its FBO. `version` bumps on every write
 * — nothing reads it yet, but it's the hook thumbnail caching (a later
 * task) will compare against instead of recomputing blindly.
 */
export class Surface {
  readonly width: number;
  readonly height: number;
  readonly texture: WebGLTexture;
  readonly fbo: WebGLFramebuffer;
  version = 0;

  constructor(gl: WebGL2RenderingContext, width: number, height: number) {
    this.width = width;
    this.height = height;

    const texture = gl.createTexture();
    if (!texture) throw new Error('Could not allocate a WebGL texture.');
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, width, height);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    const fbo = gl.createFramebuffer();
    if (!fbo) throw new Error('Could not allocate a WebGL framebuffer.');
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    this.texture = texture;
    this.fbo = fbo;
  }
}

interface ProgramInfo {
  program: WebGLProgram;
  uniforms: Record<string, WebGLUniformLocation | null>;
}

export interface CompositeOptions {
  opacity: number;
  /** Numeric index from `BLEND_INDEX`. */
  blend: number;
  /** Clip to the backdrop's alpha — used for `Layer.clipToBelow`. */
  clip?: boolean;
  /** rgb + strength (0..1); mixed into the source color before blending — used for onion skinning. */
  tint?: [number, number, number, number];
}

export class Renderer {
  readonly canvas: HTMLCanvasElement;
  readonly gl: WebGL2RenderingContext;

  private programs = new Map<string, ProgramInfo>();
  private quadVAO: WebGLVertexArrayObject;
  private scratches = new Map<string, Surface>();

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: true,
      preserveDrawingBuffer: false,
    });
    if (!gl) throw new Error('WebGL2 is not available in this browser.');
    this.gl = gl;

    this.programs.set('composite', this.link('composite', QUAD_VS, COMPOSITE_FS, [
      'uMatrix', 'uResolution', 'uFlipY', 'uSource', 'uBackdrop', 'uOpacity', 'uBlend', 'uClip', 'uTint',
    ]));
    this.programs.set('present', this.link('present', QUAD_VS, PRESENT_FS, [
      'uMatrix', 'uResolution', 'uFlipY', 'uSource', 'uDocSize', 'uCheckerScale', 'uPaper', 'uPaperAlpha',
    ]));

    const corners = new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]);
    const cornerBuf = gl.createBuffer();
    if (!cornerBuf) throw new Error('Could not allocate a WebGL buffer.');
    gl.bindBuffer(gl.ARRAY_BUFFER, cornerBuf);
    gl.bufferData(gl.ARRAY_BUFFER, corners, gl.STATIC_DRAW);

    const quadVAO = gl.createVertexArray();
    if (!quadVAO) throw new Error('Could not allocate a WebGL vertex array.');
    gl.bindVertexArray(quadVAO);
    gl.bindBuffer(gl.ARRAY_BUFFER, cornerBuf);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    this.quadVAO = quadVAO;

    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.DITHER);
  }

  private compile(type: number, src: string): WebGLShader {
    const gl = this.gl;
    const shader = gl.createShader(type);
    if (!shader) throw new Error('Could not allocate a WebGL shader.');
    gl.shaderSource(shader, src);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(shader);
      gl.deleteShader(shader);
      throw new Error(`Shader compile error: ${log}`);
    }
    return shader;
  }

  private link(name: string, vs: string, fs: string, uniforms: string[]): ProgramInfo {
    const gl = this.gl;
    const program = gl.createProgram();
    if (!program) throw new Error('Could not allocate a WebGL program.');
    const v = this.compile(gl.VERTEX_SHADER, vs);
    const f = this.compile(gl.FRAGMENT_SHADER, fs);
    gl.attachShader(program, v);
    gl.attachShader(program, f);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(`${name} link error: ${gl.getProgramInfoLog(program)}`);
    }
    gl.deleteShader(v);
    gl.deleteShader(f);
    const locs: Record<string, WebGLUniformLocation | null> = {};
    for (const u of uniforms) locs[u] = gl.getUniformLocation(program, u);
    return { program, uniforms: locs };
  }

  createSurface(width: number, height: number): Surface {
    const s = new Surface(this.gl, width, height);
    this.clear(s);
    return s;
  }

  /** Named scratch surface, recreated (and re-cleared) if the size changed. */
  private scratch(key: string, width: number, height: number): Surface {
    const existing = this.scratches.get(key);
    if (existing && existing.width === width && existing.height === height) return existing;
    const s = this.createSurface(width, height);
    this.scratches.set(key, s);
    return s;
  }

  clear(surface: Surface) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, surface.fbo);
    gl.disable(gl.BLEND);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    surface.version++;
  }

  /**
   * Uploads a decoded image (a captured photo, or any canvas-like source)
   * into `surface`, premultiplying alpha on the way in — sources like a
   * `<canvas>`/`ImageBitmap` carry straight alpha, and CLAUDE.md's
   * premultiplied-everywhere invariant has to start at the boundary.
   */
  uploadImage(surface: Surface, source: TexImageSource) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, surface.texture);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    surface.version++;
  }

  private docMatrix(width: number, height: number): Float32Array {
    return new Float32Array([width, 0, 0, 0, height, 0, 0, 0, 1]);
  }

  /**
   * `dst = blend(backdrop, src)`. `dst` must be a different surface than
   * `backdrop` and `src` — WebGL2 can't read and write the same texture in
   * one pass, so callers ping-pong between two surfaces.
   */
  composite(dst: Surface, backdrop: Surface, src: Surface, opts: CompositeOptions) {
    const gl = this.gl;
    const p = this.programs.get('composite')!;
    gl.useProgram(p.program);
    gl.bindVertexArray(this.quadVAO);
    gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fbo);
    gl.viewport(0, 0, dst.width, dst.height);
    gl.disable(gl.BLEND);

    gl.uniformMatrix3fv(p.uniforms.uMatrix, false, this.docMatrix(dst.width, dst.height));
    gl.uniform2f(p.uniforms.uResolution, dst.width, dst.height);
    gl.uniform1f(p.uniforms.uFlipY, 0);
    gl.uniform1f(p.uniforms.uOpacity, opts.opacity);
    gl.uniform1i(p.uniforms.uBlend, opts.blend);
    gl.uniform1f(p.uniforms.uClip, opts.clip ? 1 : 0);
    // Always set, even when unused: the composite program is reused across
    // calls, so a tint left over from an onion-skin pass would otherwise
    // leak into the next plain composite that doesn't pass one.
    const t = opts.tint ?? [0, 0, 0, 0];
    gl.uniform4f(p.uniforms.uTint, t[0], t[1], t[2], t[3]);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, src.texture);
    gl.uniform1i(p.uniforms.uSource, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, backdrop.texture);
    gl.uniform1i(p.uniforms.uBackdrop, 1);

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    dst.version++;
  }

  /**
   * `dst = src`, straight copy — implemented as a normal-mode composite
   * against an always-transparent backdrop rather than a separate shader
   * program: with `bd.a = 0`, `COMPOSITE_FS`'s formula reduces exactly to
   * `src * opacity`, so there's no second code path to keep in sync with
   * the premultiplied-compositing math above.
   */
  copy(dst: Surface, src: Surface) {
    const empty = this.scratch('empty', dst.width, dst.height);
    this.composite(dst, empty, src, { opacity: 1, blend: BLEND_INDEX.normal, clip: false });
  }

  /** Final pass to the canvas: paper/checkerboard under the document, Y-flip. */
  present(src: Surface, paper: RGB, paperAlpha: number, checkerScale = 32) {
    const gl = this.gl;
    const p = this.programs.get('present')!;
    gl.useProgram(p.program);
    gl.bindVertexArray(this.quadVAO);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.disable(gl.BLEND);

    gl.uniformMatrix3fv(p.uniforms.uMatrix, false, this.docMatrix(this.canvas.width, this.canvas.height));
    gl.uniform2f(p.uniforms.uResolution, this.canvas.width, this.canvas.height);
    gl.uniform1f(p.uniforms.uFlipY, 1);
    gl.uniform2f(p.uniforms.uDocSize, src.width, src.height);
    gl.uniform1f(p.uniforms.uCheckerScale, checkerScale);
    gl.uniform3f(p.uniforms.uPaper, paper.r, paper.g, paper.b);
    gl.uniform1f(p.uniforms.uPaperAlpha, paperAlpha);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, src.texture);
    gl.uniform1i(p.uniforms.uSource, 0);

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);
  }

  /**
   * Composites `doc`'s layers at `frame` into a single Surface: bottom to
   * top, clip groups first (`Layer.clipToBelow` clips to its group's base,
   * not to the whole picture below it — see `buildClipGroups`), then each
   * group merges into the accumulator using its own base layer's opacity
   * and blend mode. Returns a scratch surface owned by the renderer — copy
   * it out before the next call if the caller needs to keep it.
   */
  renderDocument(doc: ClumsyloopDocument, frame: number): Surface {
    const { width, height } = doc;
    let acc = this.scratch('acc-a', width, height);
    this.clear(acc);
    let accAlt = this.scratch('acc-b', width, height);

    for (const group of buildClipGroups(doc.layers)) {
      if (!group.base.visible) continue;
      const baseCel = celAt(group.base, frame);
      if (!baseCel) continue;

      let groupSurf = this.scratch('group-a', width, height);
      this.copy(groupSurf, baseCel.surface);
      let groupAlt = this.scratch('group-b', width, height);

      for (const layer of group.clipped) {
        if (!layer.visible) continue;
        const cel = celAt(layer, frame);
        if (!cel) continue;
        this.composite(groupAlt, groupSurf, cel.surface, {
          opacity: layer.opacity,
          blend: BLEND_INDEX[layer.blend],
          clip: true,
        });
        [groupSurf, groupAlt] = [groupAlt, groupSurf];
      }

      this.composite(accAlt, acc, groupSurf, {
        opacity: group.base.opacity,
        blend: BLEND_INDEX[group.base.blend],
        clip: false,
      });
      [acc, accAlt] = [accAlt, acc];
    }

    return acc;
  }

  /**
   * Composites `doc` at `frame` with ghost frames from before/after tinted
   * underneath it — the RoughAnimator-style onion skin `RUMBO.md` calls out
   * as relevant to Clumsyloop's own differentiator (drawing on the same
   * timeline as the camera), not just a Trace feature. Deliberately simple
   * for a first pass: every ghost frame gets the same `opacity`, no falloff
   * by distance from the current frame — that's a natural follow-up once
   * there's a real timeline UI to expose it from, not a WebGL constraint.
   *
   * Ghost frames are full re-renders of `doc` at neighboring frame numbers,
   * fully colorized to `beforeTint`/`afterTint` (tint strength 1, not just
   * mixed in) — the standard "flat red/blue silhouette" onion-skin look,
   * distinct from a normal composite's partial `CompositeOptions.tint`.
   * Frames outside `[0, doc.frameCount)` are skipped, not clamped — a
   * clamped ghost would duplicate the boundary frame's silhouette on top of
   * itself, which reads as a rendering bug, not "no more frames here".
   */
  renderOnionSkin(
    doc: ClumsyloopDocument,
    frame: number,
    opts: { before: number; after: number; beforeTint: RGB; afterTint: RGB; opacity: number },
  ): Surface {
    const { width, height } = doc;
    let out = this.scratch('onion-acc-a', width, height);
    this.clear(out);
    let outAlt = this.scratch('onion-acc-b', width, height);
    const ghost = this.scratch('onion-ghost', width, height);

    const paintGhost = (f: number, tint: RGB) => {
      if (f < 0 || f >= doc.frameCount || f === frame) return;
      this.copy(ghost, this.renderDocument(doc, f));
      this.composite(outAlt, out, ghost, {
        opacity: opts.opacity,
        blend: BLEND_INDEX.normal,
        clip: false,
        tint: [tint.r, tint.g, tint.b, 1],
      });
      [out, outAlt] = [outAlt, out];
    };

    for (let f = frame - opts.before; f < frame; f++) paintGhost(f, opts.beforeTint);
    for (let f = frame + opts.after; f > frame; f--) paintGhost(f, opts.afterTint);

    this.copy(ghost, this.renderDocument(doc, frame));
    this.composite(outAlt, out, ghost, { opacity: 1, blend: BLEND_INDEX.normal, clip: false });
    [out, outAlt] = [outAlt, out];

    return out;
  }
}
