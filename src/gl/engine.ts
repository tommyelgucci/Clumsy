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
 * listener yet to justify the pub-sub machinery. `history` (below) gets
 * its own `subscribe()` from `core/history.ts` directly, since an
 * undo/redo button genuinely does need to react independently of the
 * canvas's own imperative redraw — that's the one exception, not a
 * reversal of the no-pub-sub call.
 *
 * Also minimal on purpose: single frame (frame 0), no timeline yet — the
 * capture UI (task 2.3) is what actually needs multiple frames, and
 * that's still blocked on camera device verification (see CLAUDE.md).
 * No wet-stroke staging surface either (Trace merges a stroke onto its
 * cel only on pointer-up, mid-stroke pixels live on a scratch surface):
 * stamps go straight onto the permanent cel as they arrive. That means
 * no pigment-mix blending for the one `brush.ts` preset that wants it
 * ("Watercolor", `pigmentMix: 0.15`) and no "cancel this stroke" gesture
 * — both real, deferred simplifications, not oversights. It also means
 * undo (task added 2026-09-11) can't snapshot just the stroke's dirty
 * rect the way Trace does (that needs the pre-stroke pixels still
 * sitting untouched on a wet layer) — here the whole cel gets read back
 * once at `beginStroke`, before anything is drawn, and only the final
 * dirty rect (tracked via `expandRect` per stamp, same padding Trace
 * uses) is what actually gets kept in the `Command`.
 */
import { History, type Command } from '../core/history';
import { StrokeBuilder, type BrushPreset } from '../core/brush';
import { generateBrushTexturePixels, isBuiltinTextureId } from '../core/brushTexture';
import { celAt, uid, type Cel, type ClumsyloopDocument, type Layer } from '../core/document';
import { extractRect } from '../core/flood';
import { mat3FromTRS } from '../core/math';
import { clampRect, emptyRect, expandRect, rectIsEmpty, type InputSample, type RGB, type Stamp } from '../core/types';
import type { FloodFillResponse } from '../workers/floodFill.worker';
import { Renderer } from './renderer';

export class Engine {
  readonly renderer: Renderer;
  readonly doc: ClumsyloopDocument;
  readonly history = new History();
  private _activeLayerId: string;

  private builder: StrokeBuilder | null = null;
  private strokeBrush: BrushPreset | null = null;
  private strokeColor: RGB = { r: 0, g: 0, b: 0 };
  /** Undo bookkeeping for the stroke in progress — see `beginStroke`/`endStroke`. */
  private strokeCel: Cel | null = null;
  private strokeCelCreated = false;
  private strokeBefore: Uint8Array | null = null;
  private strokeRect = emptyRect();

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

  /** The active layer's cel at frame 0, creating one if none exists yet.
   *  `created` tells the caller whether to remove the cel entirely on
   *  undo (matching Trace's `ensureCel`) — a stroke or fill that made a
   *  brand-new cel didn't just edit pixels, it also brought the cel
   *  itself into existence, and undo has to reverse both. Single-frame
   *  for now (see file header) — `celAt` still goes through the real
   *  lookup rather than reading `.cels.get(0)` directly so this keeps
   *  working unchanged once a timeline lets frame 0 hold a cel that
   *  actually started earlier (it can't yet: nothing sets a cel below 0). */
  private ensureCel(layer: Layer): { cel: Cel; created: boolean } {
    const existing = celAt(layer, 0);
    if (existing) return { cel: existing, created: false };
    const cel: Cel = { id: uid('cel'), surface: this.renderer.createSurface(`${layer.id}-cel`) };
    layer.cels.set(0, cel);
    return { cel, created: true };
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
    const { cel, created } = this.ensureCel(this.activeLayer);
    this.strokeCel = cel;
    this.strokeCelCreated = created;
    // The one full-cel read this whole approach costs (see file header)
    // — taken now, before a single stamp lands, so it's the exact
    // pre-stroke state regardless of how big the stroke's dirty rect
    // ends up being.
    this.strokeBefore = this.renderer.readRect(cel.surface, 0, 0, this.doc.width, this.doc.height);
    this.strokeRect = emptyRect();
    this.paintStamps(this.builder.begin(sample));
  }

  pushStroke(sample: InputSample) {
    if (!this.builder) return;
    this.paintStamps(this.builder.push(sample));
  }

  endStroke() {
    if (!this.builder || !this.strokeCel || !this.strokeBefore) {
      this.builder = null;
      return;
    }
    this.paintStamps(this.builder.end());
    this.builder = null;
    const label = this.strokeBrush?.erase ? 'Erase' : 'Stroke';
    this.strokeBrush = null;

    const cel = this.strokeCel;
    const created = this.strokeCelCreated;
    const fullBefore = this.strokeBefore;
    const layer = this.activeLayer;
    this.strokeCel = null;
    this.strokeBefore = null;

    const rect = clampRect(this.strokeRect, this.doc.width, this.doc.height);
    this.strokeRect = emptyRect();
    if (rectIsEmpty(rect)) {
      // A tap that produced no stamps at all (shouldn't normally happen —
      // StrokeBuilder.begin() always emits at least one — but a
      // just-created cel shouldn't be left behind for nothing either way).
      if (created) layer.cels.delete(0);
      return;
    }

    const rectW = rect.x2 - rect.x;
    const rectH = rect.y2 - rect.y;
    const before = extractRect(fullBefore, this.doc.width, rect);
    const after = this.renderer.readRect(cel.surface, rect.x, rect.y, rectW, rectH);

    // `push`, not `run`: the stroke already happened live, stamp by
    // stamp, while it was being drawn — this only records it.
    this.history.push({
      label,
      cost: before.byteLength + after.byteLength,
      redo: () => {
        if (created) layer.cels.set(0, cel);
        this.renderer.writeRect(cel.surface, rect.x, rect.y, rectW, rectH, after);
      },
      undo: () => {
        this.renderer.writeRect(cel.surface, rect.x, rect.y, rectW, rectH, before);
        if (created) layer.cels.delete(0);
      },
    });
  }

  private paintStamps(stamps: Stamp[]) {
    if (stamps.length === 0 || !this.strokeBrush || !this.strokeCel) return;
    for (const s of stamps) expandRect(this.strokeRect, s.x, s.y, s.size * 0.75 + 2);
    this.renderer.drawStamps(this.strokeCel.surface, stamps, this.strokeColor, this.brushTexture(this.strokeBrush), this.strokeBrush.erase);
    this.renderAndPresent();
  }

  /** Clears the active layer's cel, undoably. A no-op (no history entry)
   *  on a layer with nothing to clear — clicking Clear on a blank layer
   *  shouldn't leave a phantom empty cel behind for undo to trip over. */
  clearActiveLayer() {
    const layer = this.activeLayer;
    const cel = celAt(layer, 0);
    if (!cel || cel.surface.empty) return;
    const w = this.doc.width;
    const h = this.doc.height;
    const before = this.renderer.readRect(cel.surface, 0, 0, w, h);
    this.renderer.clear(cel.surface);
    this.history.push({
      label: 'Clear',
      cost: before.byteLength,
      redo: () => this.renderer.clear(cel.surface),
      undo: () => this.renderer.writeRect(cel.surface, 0, 0, w, h, before),
    });
    this.renderAndPresent();
  }

  undo(): boolean {
    const did = this.history.undo();
    if (did) this.renderAndPresent();
    return did;
  }

  redo(): boolean {
    const did = this.history.redo();
    if (did) this.renderAndPresent();
    return did;
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
      // Both buffers are transferred, not copied — the caller (below)
      // already took its own copy of `target` before this, precisely
      // because this transfer detaches the original.
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
   * photo or a locked layer doesn't make sense.
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
    const { cel, created } = this.ensureCel(layer);
    const target = this.renderer.readRect(cel.surface, 0, 0, w, h);
    // `target`'s buffer is about to be transferred into the worker
    // (zero-copy — see `runFloodFillWorker`), which detaches it on this
    // side; undo needs its own untouched copy, taken before that happens.
    const targetSnapshot = target.slice();

    const { sub, rect } = await this.runFloodFillWorker(reference, target, w, h, sx, sy, tolerance, expand, gapClose, color, layer.alphaLock);
    const rectW = rect.x2 - rect.x;
    const rectH = rect.y2 - rect.y;
    const before = extractRect(targetSnapshot, w, rect);

    const cmd: Command = {
      label: 'Fill',
      cost: sub.byteLength + before.byteLength,
      redo: () => {
        if (created) layer.cels.set(0, cel);
        this.renderer.writeRect(cel.surface, rect.x, rect.y, rectW, rectH, sub);
      },
      undo: () => {
        this.renderer.writeRect(cel.surface, rect.x, rect.y, rectW, rectH, before);
        if (created) layer.cels.delete(0);
      },
    };
    // `run`, not `push`: unlike a stroke, nothing has actually been
    // written to the GPU yet — `redo()` is what performs the fill.
    this.history.run(cmd);
    this.renderAndPresent();
  }

  renderAndPresent() {
    const result = this.renderer.renderDocumentFrame(this.doc, 0);
    const canvas = this.renderer.canvas;
    const viewMatrix = mat3FromTRS(0, 0, 0, canvas.width, canvas.height);
    this.renderer.present(result, viewMatrix, this.doc.paper, this.doc.paperAlpha, 16);
  }
}
