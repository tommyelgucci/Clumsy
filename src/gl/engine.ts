/**
 * Drawing engine: the first real (non-harness) consumer of `brush.ts`
 * and the renderer's stamping/compositing pipeline — the piece
 * `checkpoint.md` flagged brush.ts as ported groundwork for, back when
 * it landed with no consumer yet.
 *
 * Deliberately minimal, not a port of Trace's `core/engine.ts`: no
 * revision/`touch()`/subscribe pub-sub (CLAUDE.md's documented pattern)
 * yet — that exists in Trace because many independent UI pieces (layers
 * panel, undo button, timeline) all need to react to document mutations
 * outside React's own state flow. This engine has exactly one consumer
 * so far, the canvas itself, and it updates the canvas imperatively via
 * `renderAndPresent()` right after every mutation — there's no second
 * listener yet to justify the pub-sub machinery. Add it when a real one
 * shows up (a layers panel, a frame counter), not before.
 *
 * Also minimal on purpose: single frame (frame 0), no timeline yet — the
 * capture UI (task 2.3) is what actually needs multiple frames, and
 * that's still blocked on camera device verification (see CLAUDE.md).
 * No wet-stroke staging surface either (Trace merges a stroke onto its
 * cel only on pointer-up, mid-stroke pixels live on a scratch surface):
 * stamps go straight onto the permanent cel as they arrive. That means
 * no pigment-mix blending for the one `brush.ts` preset that wants it
 * ("Watercolor", `pigmentMix: 0.15`) and no "cancel this stroke" gesture
 * — both real, deferred simplifications, not oversights.
 */
import { StrokeBuilder, type BrushPreset } from '../core/brush';
import { generateBrushTexturePixels, isBuiltinTextureId } from '../core/brushTexture';
import { celAt, uid, type Cel, type ClumsyloopDocument, type Layer } from '../core/document';
import { mat3FromTRS } from '../core/math';
import type { InputSample, RGB, Stamp } from '../core/types';
import { Renderer } from './renderer';

export class Engine {
  readonly renderer: Renderer;
  readonly doc: ClumsyloopDocument;
  readonly activeLayerId: string;

  private builder: StrokeBuilder | null = null;
  private strokeBrush: BrushPreset | null = null;
  private strokeColor: RGB = { r: 0, g: 0, b: 0 };

  constructor(renderer: Renderer, doc: ClumsyloopDocument, activeLayerId: string) {
    this.renderer = renderer;
    this.doc = doc;
    this.activeLayerId = activeLayerId;
    this.renderer.setDocumentSize(doc.width, doc.height);
  }

  private get activeLayer(): Layer {
    const layer = this.doc.layers.find((l) => l.id === this.activeLayerId);
    if (!layer) throw new Error(`Engine: no layer with id ${this.activeLayerId}`);
    return layer;
  }

  /** The active layer's cel at frame 0, created empty on first use.
   *  Single-frame for now (see file header) — `celAt` still goes through
   *  the real lookup rather than reading `.cels.get(0)` directly so this
   *  keeps working unchanged once a timeline lets frame 0 hold a cel that
   *  actually started earlier (it can't yet: nothing sets a cel below 0). */
  private activeCel(): Cel {
    const layer = this.activeLayer;
    const existing = celAt(layer, 0);
    if (existing) return existing;
    const cel: Cel = { id: uid('cel'), surface: this.renderer.createSurface(`${layer.id}-cel`) };
    layer.cels.set(0, cel);
    return cel;
  }

  private brushTexture(brush: BrushPreset): WebGLTexture | undefined {
    const id = brush.textureId;
    if (!id || !isBuiltinTextureId(id)) return undefined;
    return this.renderer.getBrushTexture(id, () => ({ pixels: generateBrushTexturePixels(id), hasColor: false }));
  }

  beginStroke(brush: BrushPreset, color: RGB, sample: InputSample) {
    this.strokeBrush = brush;
    this.strokeColor = color;
    this.builder = new StrokeBuilder(brush);
    this.paintStamps(this.builder.begin(sample));
  }

  pushStroke(sample: InputSample) {
    if (!this.builder) return;
    this.paintStamps(this.builder.push(sample));
  }

  endStroke() {
    if (!this.builder) return;
    this.paintStamps(this.builder.end());
    this.builder = null;
    this.strokeBrush = null;
  }

  private paintStamps(stamps: Stamp[]) {
    if (stamps.length === 0 || !this.strokeBrush) return;
    const cel = this.activeCel();
    this.renderer.drawStamps(cel.surface, stamps, this.strokeColor, this.brushTexture(this.strokeBrush), this.strokeBrush.erase);
    this.renderAndPresent();
  }

  clearActiveLayer() {
    this.renderer.clear(this.activeCel().surface);
    this.renderAndPresent();
  }

  renderAndPresent() {
    const result = this.renderer.renderDocumentFrame(this.doc, 0);
    const canvas = this.renderer.canvas;
    const viewMatrix = mat3FromTRS(0, 0, 0, canvas.width, canvas.height);
    this.renderer.present(result, viewMatrix, this.doc.paper, this.doc.paperAlpha, 16);
  }
}
