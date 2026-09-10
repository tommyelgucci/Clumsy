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
import type { FloodFillResponse } from '../workers/floodFill.worker';
import { Renderer } from './renderer';

export class Engine {
  readonly renderer: Renderer;
  readonly doc: ClumsyloopDocument;
  private _activeLayerId: string;

  private builder: StrokeBuilder | null = null;
  private strokeBrush: BrushPreset | null = null;
  private strokeColor: RGB = { r: 0, g: 0, b: 0 };

  constructor(renderer: Renderer, doc: ClumsyloopDocument, activeLayerId: string) {
    this.renderer = renderer;
    this.doc = doc;
    this._activeLayerId = activeLayerId;
    this.renderer.setDocumentSize(doc.width, doc.height);
  }

  get activeLayerId(): string {
    return this._activeLayerId;
  }

  /** Switches which layer strokes/fills write into. No layers panel uses
   *  this yet (`DrawingCanvas` only ever has one fixed layer) — added so
   *  bucket fill's reference-layer behavior (painting one layer using
   *  another's boundaries) has a real way to be exercised at all, by a
   *  future layers panel or a test. */
  setActiveLayer(id: string) {
    if (!this.doc.layers.some((l) => l.id === id)) throw new Error(`Engine: no layer with id ${id}`);
    this._activeLayerId = id;
  }

  private get activeLayer(): Layer {
    const layer = this.doc.layers.find((l) => l.id === this._activeLayerId);
    if (!layer) throw new Error(`Engine: no layer with id ${this._activeLayerId}`);
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

  /** Lazy worker for the CPU-side part of `floodFill` — one thread for
   *  the Engine's whole life, not one per fill; the worker doesn't keep
   *  anything between messages. */
  private floodWorker: Worker | null = null;
  private floodPending = new Map<number, (r: FloodFillResponse) => void>();
  private floodRequestId = 0;
  private getFloodWorker(): Worker {
    if (!this.floodWorker) {
      const worker = new Worker(new URL('../workers/floodFill.worker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = (e: MessageEvent<FloodFillResponse>) => {
        const resolve = this.floodPending.get(e.data.id);
        if (!resolve) return;
        this.floodPending.delete(e.data.id);
        resolve(e.data);
      };
      this.floodWorker = worker;
    }
    return this.floodWorker;
  }

  private runFloodFillWorker(
    reference: Uint8Array,
    target: Uint8Array,
    w: number,
    h: number,
    sx: number,
    sy: number,
    tolerance: number,
    expand: number,
    gapClose: number,
    color: RGB,
    alphaLock: boolean,
  ): Promise<FloodFillResponse> {
    return new Promise((resolve) => {
      const worker = this.getFloodWorker();
      const id = ++this.floodRequestId;
      this.floodPending.set(id, resolve);
      // Both buffers are transferred, not copied — the caller already
      // took its own copy of `target` before this (see `floodFill`), so
      // it doesn't need either one back.
      worker.postMessage({ id, reference, target, w, h, sx, sy, tolerance, expand, gapClose, color, alphaLock }, [reference.buffer, target.buffer]);
    });
  }

  /**
   * Bucket fill (task 2.7) on the active layer, at document point `(x, y)`.
   *
   * The reference is the whole composited document at the current frame,
   * not the active layer's own cel: coloring an animation wants the
   * bucket to respect ink on ANY visible layer above the one being
   * painted (lineart on one layer, color on another) — see `checkpoint.md`
   * for the reference-layer-fill reasoning. The write always goes to the
   * active layer's cel.
   *
   * `gapClose` (pixels of line-break the fill can't leak through) is a
   * distinct knob from `expand` (pixels the fill bleeds past the wall's
   * edge, to cover antialiasing) — see `core/flood.ts`.
   *
   * No-op on a locked, hidden, or non-`draw` layer — filling a camera
   * photo or a locked layer doesn't make sense. No undo yet: this engine
   * doesn't wire `history.ts` for strokes either (see the file header),
   * so a single tool having it would be inconsistent, not an improvement.
   */
  async floodFill(x: number, y: number, color: RGB, tolerance = 0.15, expand = 2, gapClose = 2): Promise<void> {
    const layer = this.activeLayer;
    if (layer.locked || !layer.visible || layer.kind !== 'draw') return;
    const w = this.doc.width;
    const h = this.doc.height;
    const sx = Math.floor(x);
    const sy = Math.floor(y);
    if (sx < 0 || sy < 0 || sx >= w || sy >= h) return;

    const reference = this.renderer.readRect(this.renderer.renderDocumentFrame(this.doc, 0), 0, 0, w, h);
    const cel = this.activeCel();
    const target = this.renderer.readRect(cel.surface, 0, 0, w, h);

    const { sub, rect } = await this.runFloodFillWorker(reference, target, w, h, sx, sy, tolerance, expand, gapClose, color, layer.alphaLock);
    this.renderer.writeRect(cel.surface, rect.x, rect.y, rect.x2 - rect.x, rect.y2 - rect.y, sub);
    this.renderAndPresent();
  }

  renderAndPresent() {
    const result = this.renderer.renderDocumentFrame(this.doc, 0);
    const canvas = this.renderer.canvas;
    const viewMatrix = mat3FromTRS(0, 0, 0, canvas.width, canvas.height);
    this.renderer.present(result, viewMatrix, this.doc.paper, this.doc.paperAlpha, 16);
  }
}
