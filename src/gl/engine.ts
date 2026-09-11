/**
 * Drawing engine: the first real (non-harness) consumer of `brush.ts`
 * and the renderer's stamping/compositing pipeline — the piece
 * `checkpoint.md` flagged brush.ts as ported groundwork for, back when
 * it landed with no consumer yet.
 *
 * Deliberately minimal, not a port of Trace's `core/engine.ts` — but as
 * of the layers panel (task 2.9) it does carry CLAUDE.md's documented
 * `touch()`/revision/`subscribe()` pattern, added at exactly the point
 * that pattern's own justification (a second independent UI consumer
 * that needs to react to document mutations outside React's own state
 * flow) actually showed up: the canvas keeps redrawing itself
 * imperatively via `renderAndPresent()`, but the layers panel needs to
 * know when a layer is added/removed/reordered/renamed/toggled, which
 * doesn't otherwise touch the canvas. `touch()` lives inside
 * `renderAndPresent()` itself rather than being called separately by
 * every mutator — every mutation already ends in a call to
 * `renderAndPresent()`, so piggybacking the revision bump there covers
 * strokes, fills, Clear, undo/redo, and every layer operation for free,
 * with no risk of a mutator forgetting to call `touch()` on its own.
 * `history` (below) still gets its own separate `subscribe()` from
 * `core/history.ts` — undo/redo state is its own concept, not a document
 * revision, and the Undo/Redo buttons only care about it specifically.
 *
 * Multi-frame timeline (task 2.14): draw-only frame-by-frame animation —
 * `currentFrame` navigation, add/duplicate/delete a cel on the active
 * layer, onion skin, and an fps setter. This is the camera-independent
 * half of what task 2.3 originally bundled together ("onion skin,
 * shutter, filmstrip"): the shutter itself still needs the still-blocked
 * native camera plugin, but frame navigation and onion skinning need
 * nothing from the camera at all — a document already models cels as a
 * sparse `Map<frame, Cel>` per layer (core/document.ts, ported from
 * Trace) and the renderer already composites at an arbitrary `frame`
 * (gl/renderer.ts's `renderDocumentFrame`) — neither needed a single
 * line changed for this. `ensureCel`/`beginStroke`/`clearActiveLayer`/
 * `floodFill` below all generalize from a hardcoded frame 0 to whatever
 * `currentFrame` is at the time the action starts, captured once (not
 * read live) so a frame change mid-action can't retarget it.
 *
 * Non-erase strokes (task 2.10) now go through a wet-stroke staging
 * surface, matching Trace: stamps land on a scratch surface
 * (`renderer.scratch('wetStroke')`) for the whole stroke, composited live
 * on top of the active layer's own cel for the canvas preview
 * (`Renderer.renderDocumentFrame`'s `wetOverlay` param), and only
 * `drawOver`'d onto the permanent cel for real at `endStroke`. Two real
 * things this buys: undo can finally read the dirty rect's "before" state
 * right before the merge — no need to snapshot the whole cel up front the
 * way the erase path (below) still has to — and pigment-mix blending
 * (`BrushPreset.pigmentMix`, the one `brush.ts` field this engine still
 * doesn't act on — see "Watercolor") now has an actual seam to hook into
 * at merge time, once it's built; it isn't yet, so today's merge is plain
 * `drawOver` regardless of `pigmentMix`, same visual result as before this
 * task for every brush that doesn't set it. A "cancel this stroke"
 * gesture (discard the wet surface, touch nothing) is also now trivial to
 * add but isn't exposed by any UI yet.
 *
 * Erase strokes deliberately do NOT go through the wet surface: erasing
 * uses `blendFunc(ZERO, ONE_MINUS_SRC_ALPHA)` to punch a hole in whatever
 * is already there, which only makes sense against the real permanent
 * cel — erasing onto an initially-transparent wet surface would have
 * nothing to erase, and merging that empty result with a normal
 * `drawOver` would silently undo the whole erase. So erase keeps stamping
 * straight onto the permanent cel, and keeps the older undo approach:
 * the whole cel read back once at `beginStroke`, before anything is
 * drawn, with only the final dirty rect (`expandRect` per stamp, same
 * padding Trace uses) kept in the `Command`.
 */
import { History, type Command } from '../core/history';
import { StrokeBuilder, type BrushPreset } from '../core/brush';
import { generateBrushTexturePixels, isBuiltinTextureId } from '../core/brushTexture';
import { celAt, clampFrame, newLayer, uid, type Cel, type ClumsyloopDocument, type Layer } from '../core/document';
import { extractRect } from '../core/flood';
import { mat3FromTRS } from '../core/math';
import { clampRect, emptyRect, expandRect, rectIsEmpty, type InputSample, type RGB, type Stamp } from '../core/types';
import type { FloodFillResponse } from '../workers/floodFill.worker';
import { Renderer, type Surface } from './renderer';

export class Engine {
  readonly renderer: Renderer;
  readonly doc: ClumsyloopDocument;
  readonly history = new History();
  private _activeLayerId: string;
  private _revision = 0;
  private revisionListeners = new Set<() => void>();
  private _currentFrame = 0;
  private _onionSkin = false;
  /** Fixed ghost opacity — Trace's own onion skin has separately
   *  configurable before/after frame counts, opacity, and a tinted
   *  before/after color; this first pass covers only the single most
   *  common case (one frame back, fixed intensity, no tint) since that's
   *  what actually unblocks drawing a walk cycle or a simple loop today.
   *  A richer onion-skin panel is real future work, not an oversight. */
  private static readonly ONION_OPACITY = 0.35;

  private builder: StrokeBuilder | null = null;
  private strokeBrush: BrushPreset | null = null;
  private strokeColor: RGB = { r: 0, g: 0, b: 0 };
  private strokeLayer: Layer | null = null;
  /** The frame `beginStroke` was called on, captured once so a frame
   *  change mid-stroke (shouldn't happen — `setCurrentFrame` already
   *  ends any in-progress stroke first — but this is the belt-and-
   *  suspenders version) can't retarget where `endStroke` writes. */
  private strokeFrame = 0;
  /** Whether the stroke in progress goes through the wet staging surface
   *  (see file header) — false only for erase, which still draws straight
   *  onto the permanent cel and needs the older whole-cel undo fields
   *  below. */
  private strokeUsesWet = false;
  /** Erase-path undo bookkeeping only — see `beginStroke`/`endStroke`. */
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

  get revision(): number {
    return this._revision;
  }

  /** Notified after every mutation (see the file header) — a layers panel
   *  or any future UI piece that isn't the canvas itself uses this to
   *  know when to re-render. */
  subscribe(fn: () => void): () => void {
    this.revisionListeners.add(fn);
    return () => this.revisionListeners.delete(fn);
  }

  get currentFrame(): number {
    return this._currentFrame;
  }

  get onionSkinEnabled(): boolean {
    return this._onionSkin;
  }

  /** Moves the timeline playhead. Ends any in-progress stroke first (same
   *  reasoning as Trace's `setFrame`) so a stroke never straddles two
   *  frames. A no-op if already on that frame, so toggling onion skin or
   *  redrawing doesn't retrigger a redundant present(). */
  setCurrentFrame(frame: number) {
    const f = clampFrame(this.doc, frame);
    if (f === this._currentFrame) return;
    if (this.builder) this.endStroke();
    this._currentFrame = f;
    this.renderAndPresent();
  }

  stepFrame(delta: number) {
    this.setCurrentFrame(this._currentFrame + delta);
  }

  setOnionSkin(enabled: boolean) {
    if (this._onionSkin === enabled) return;
    this._onionSkin = enabled;
    this.renderAndPresent();
  }

  /** Direct metadata mutation, not wrapped in history — same as
   *  `renameLayer`: this changes how the timeline plays back, not any
   *  pixels, so there's nothing for undo to meaningfully restore. */
  setFps(fps: number) {
    const f = Math.max(1, Math.round(fps));
    if (f === this.doc.fps) return;
    this.doc.fps = f;
    this.renderAndPresent();
  }

  /** Adds a cel to the active layer at the frame right after the current
   *  one — `duplicate` copies the pixels currently held there (the frame
   *  Trace's own "duplicate frame" button uses), otherwise the new cel
   *  starts blank. Camera-only layers aren't a target here for the same
   *  reason `addLayer` never creates one: a camera layer's cels only ever
   *  come from the still-blocked capture UI's shutter (see CLAUDE.md). If
   *  a cel already exists at that frame, this just jumps there instead of
   *  overwriting it — the affordance is "advance the timeline", not
   *  "always create". Undoable: unlike a bare new layer, a duplicated cel
   *  can carry real pixels worth restoring; growing `doc.frameCount` to
   *  fit is reversed by the same command so undo doesn't leave the
   *  timeline longer than before the action. */
  addCel(duplicate = false): Cel | undefined {
    const layer = this.activeLayer;
    if (layer.kind !== 'draw') return undefined;
    const frame = this._currentFrame + 1;
    if (layer.cels.has(frame)) {
      this.setCurrentFrame(frame);
      return layer.cels.get(frame);
    }
    const cel: Cel = { id: uid('cel'), surface: this.renderer.createSurface(`${layer.id}-cel`) };
    if (duplicate) {
      const prev = celAt(layer, this._currentFrame);
      if (prev) this.renderer.copy(cel.surface, prev.surface, 1);
    }
    const fromFrame = this._currentFrame;
    const prevFrameCount = this.doc.frameCount;
    const needsGrow = frame >= this.doc.frameCount;
    const wasAnimated = layer.animated;
    this.history.run({
      label: duplicate ? 'Duplicate frame' : 'New frame',
      redo: () => {
        layer.animated = true;
        layer.cels.set(frame, cel);
        if (needsGrow) this.doc.frameCount = frame + 1;
        this._currentFrame = frame;
      },
      undo: () => {
        layer.cels.delete(frame);
        layer.animated = wasAnimated;
        if (needsGrow) this.doc.frameCount = prevFrameCount;
        this._currentFrame = fromFrame;
      },
    });
    this.renderAndPresent();
    return cel;
  }

  /** Removes the active layer's cel that STARTS exactly at the current
   *  frame — same as Trace's `deleteCel`, and deliberately not "whichever
   *  cel is currently held", so this can't accidentally delete a cel that
   *  started several frames earlier just because playback is sitting
   *  somewhere in its hold. A no-op if the current frame isn't itself a
   *  cel's start. Undoable, unlike `removeLayer` — a deleted cel's
   *  surface isn't released immediately, since (unlike layer removal)
   *  this action can still be redone/undone. */
  deleteCel() {
    const layer = this.activeLayer;
    const frame = this._currentFrame;
    const cel = layer.cels.get(frame);
    if (!cel) return;
    this.history.run({
      label: 'Delete frame',
      redo: () => layer.cels.delete(frame),
      undo: () => layer.cels.set(frame, cel),
    });
    this.renderAndPresent();
  }

  /** Switches which layer strokes/fills write into. Used by the layers
   *  panel (task 2.9) and, before that, bucket fill's reference-layer
   *  behavior (painting one layer using another's boundaries as its
   *  boundary) to exercise a second layer at all. */
  setActiveLayer(id: string) {
    if (!this.doc.layers.some((l) => l.id === id)) throw new Error(`Engine: no layer with id ${id}`);
    this._activeLayerId = id;
    this.renderAndPresent();
  }

  /** Adds a new draw layer on top of the stack and makes it active. Only
   *  ever `'draw'` — a camera layer's cels come from the (still
   *  device-blocked, see CLAUDE.md) capture UI, not from a button a user
   *  taps in a drawing panel, so there's nothing meaningful to add here
   *  yet. No undo: unlike a stroke or fill, a bare new layer has no
   *  pixels to lose, so there's nothing undoing it would meaningfully
   *  restore beyond what re-clicking "Delete" already does. */
  addLayer(name?: string): Layer {
    const layer = newLayer(name ?? `Layer ${this.doc.layers.length + 1}`, true, 'draw');
    this.doc.layers.push(layer);
    this._activeLayerId = layer.id;
    this.renderAndPresent();
    return layer;
  }

  /** Removes a layer and releases its cels' GPU surfaces — safe to do
   *  immediately since (unlike stroke/fill undo) layer removal isn't
   *  undoable, so nothing else can still need that texture afterward.
   *  Refuses to remove the last layer: the document always needs
   *  somewhere to paint. Returns whether it actually removed anything,
   *  so the UI can tell a real deletion from a no-op. */
  removeLayer(id: string): boolean {
    if (this.doc.layers.length <= 1) return false;
    const index = this.doc.layers.findIndex((l) => l.id === id);
    if (index < 0) return false;
    const [layer] = this.doc.layers.splice(index, 1);
    for (const cel of layer.cels.values()) this.renderer.release(cel.surface);
    if (this._activeLayerId === id) {
      this._activeLayerId = this.doc.layers[Math.max(0, index - 1)].id;
    }
    this.renderAndPresent();
    return true;
  }

  /** Swaps a layer with its neighbor toward the top (`'up'`) or bottom
   *  (`'down'`) of the stack — `doc.layers` is bottom-to-top, so "up" in
   *  the panel's stacking order means a higher array index. No-op at
   *  either end of the stack. */
  moveLayer(id: string, direction: 'up' | 'down') {
    const layers = this.doc.layers;
    const i = layers.findIndex((l) => l.id === id);
    if (i < 0) return;
    const j = direction === 'up' ? i + 1 : i - 1;
    if (j < 0 || j >= layers.length) return;
    [layers[i], layers[j]] = [layers[j], layers[i]];
    this.renderAndPresent();
  }

  setLayerVisible(id: string, visible: boolean) {
    const layer = this.doc.layers.find((l) => l.id === id);
    if (!layer) return;
    layer.visible = visible;
    this.renderAndPresent();
  }

  setLayerLocked(id: string, locked: boolean) {
    const layer = this.doc.layers.find((l) => l.id === id);
    if (!layer) return;
    layer.locked = locked;
    this.renderAndPresent();
  }

  renameLayer(id: string, name: string) {
    const layer = this.doc.layers.find((l) => l.id === id);
    if (!layer || !name.trim()) return;
    layer.name = name.trim();
    this.renderAndPresent();
  }

  private get activeLayer(): Layer {
    const layer = this.doc.layers.find((l) => l.id === this._activeLayerId);
    if (!layer) throw new Error(`Engine: no layer with id ${this._activeLayerId}`);
    return layer;
  }

  /** The active layer's cel held at `frame` (defaults to the current
   *  playhead), creating one if none exists yet. `celAt` finds the most
   *  recently *started* cel at or before `frame`, not one at that exact
   *  key — so drawing on a frame that's mid-hold edits the cel that's
   *  already showing there instead of splitting it, the same convention
   *  traditional animation (and Trace) uses; only a frame with nothing
   *  held before it at all gets a brand-new cel, inserted at `frame`
   *  itself. `created` tells the caller whether to remove the cel
   *  entirely on undo (matching Trace's `ensureCel`) — a stroke or fill
   *  that made a brand-new cel didn't just edit pixels, it also brought
   *  the cel itself into existence, and undo has to reverse both. */
  private ensureCel(layer: Layer, frame: number = this._currentFrame): { cel: Cel; created: boolean } {
    const existing = celAt(layer, frame);
    if (existing) return { cel: existing, created: false };
    const cel: Cel = { id: uid('cel'), surface: this.renderer.createSurface(`${layer.id}-cel`) };
    layer.cels.set(frame, cel);
    return { cel, created: true };
  }

  private brushTexture(brush: BrushPreset): WebGLTexture | undefined {
    const id = brush.textureId;
    if (!id || !isBuiltinTextureId(id)) return undefined;
    return this.renderer.getBrushTexture(id, () => ({ pixels: generateBrushTexturePixels(id), hasColor: false }));
  }

  /** No-op (builder stays null, so `pushStroke`/`endStroke` are no-ops
   *  too) on a locked, hidden, or non-`draw` layer — same guard
   *  `floodFill` already has, now also enforced for strokes. Locking a
   *  layer via the layers panel (task 2.9) needs this to actually mean
   *  something: before this guard, `locked` only stopped bucket fills. */
  beginStroke(brush: BrushPreset, color: RGB, sample: InputSample) {
    const layer = this.activeLayer;
    if (layer.locked || !layer.visible || layer.kind !== 'draw') return;
    this.strokeBrush = brush;
    this.strokeColor = color;
    this.strokeLayer = layer;
    this.strokeFrame = this._currentFrame;
    this.strokeUsesWet = !brush.erase;
    this.builder = new StrokeBuilder(brush);
    this.strokeRect = emptyRect();

    if (this.strokeUsesWet) {
      // Wet staging (see file header): the permanent cel isn't touched
      // at all until endStroke merges into it, so it doesn't even need
      // to exist yet — ensureCel happens lazily there instead.
      this.renderer.clear(this.renderer.scratch('wetStroke'));
      this.strokeCel = null;
      this.strokeCelCreated = false;
      this.strokeBefore = null;
    } else {
      // Erase can't use the wet surface (see file header) — stamps go
      // straight onto the permanent cel, so undo still needs the whole
      // pre-stroke cel read up front, before anything is drawn.
      const { cel, created } = this.ensureCel(layer, this.strokeFrame);
      this.strokeCel = cel;
      this.strokeCelCreated = created;
      this.strokeBefore = this.renderer.readRect(cel.surface, 0, 0, this.doc.width, this.doc.height);
    }
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
    const label = this.strokeBrush?.erase ? 'Erase' : 'Stroke';
    this.strokeBrush = null;

    const rect = clampRect(this.strokeRect, this.doc.width, this.doc.height);
    this.strokeRect = emptyRect();
    const frame = this.strokeFrame;

    if (this.strokeUsesWet) {
      const layer = this.strokeLayer;
      this.strokeLayer = null;
      // A tap that produced no stamps at all (shouldn't normally happen —
      // StrokeBuilder.begin() always emits at least one) leaves the
      // permanent cel untouched either way, since it was never created
      // for this stroke in the first place — nothing to clean up.
      if (!layer || rectIsEmpty(rect)) return;

      const { cel, created } = this.ensureCel(layer, frame);
      const rectW = rect.x2 - rect.x;
      const rectH = rect.y2 - rect.y;
      // The precise dirty-rect "before" state, read right before the
      // merge — possible now because the wet surface kept the permanent
      // cel completely untouched up to this exact point (see file header;
      // the erase path below still can't do this).
      const before = this.renderer.readRect(cel.surface, rect.x, rect.y, rectW, rectH);
      this.renderer.drawOver(cel.surface, this.renderer.scratch('wetStroke'));
      const after = this.renderer.readRect(cel.surface, rect.x, rect.y, rectW, rectH);

      // `push`, not `run`: the merge already happened, just above.
      this.history.push({
        label,
        cost: before.byteLength + after.byteLength,
        redo: () => {
          if (created) layer.cels.set(frame, cel);
          this.renderer.writeRect(cel.surface, rect.x, rect.y, rectW, rectH, after);
        },
        undo: () => {
          this.renderer.writeRect(cel.surface, rect.x, rect.y, rectW, rectH, before);
          if (created) layer.cels.delete(frame);
        },
      });
      return;
    }

    // Erase path: unchanged from before task 2.10 — stamps already went
    // straight onto the permanent cel throughout the stroke.
    if (!this.strokeCel || !this.strokeBefore) return;
    const cel = this.strokeCel;
    const created = this.strokeCelCreated;
    const fullBefore = this.strokeBefore;
    const layer = this.strokeLayer ?? this.activeLayer;
    this.strokeCel = null;
    this.strokeBefore = null;
    this.strokeLayer = null;

    if (rectIsEmpty(rect)) {
      if (created) layer.cels.delete(frame);
      return;
    }

    const rectW = rect.x2 - rect.x;
    const rectH = rect.y2 - rect.y;
    const before = extractRect(fullBefore, this.doc.width, rect);
    const after = this.renderer.readRect(cel.surface, rect.x, rect.y, rectW, rectH);

    this.history.push({
      label,
      cost: before.byteLength + after.byteLength,
      redo: () => {
        if (created) layer.cels.set(frame, cel);
        this.renderer.writeRect(cel.surface, rect.x, rect.y, rectW, rectH, after);
      },
      undo: () => {
        this.renderer.writeRect(cel.surface, rect.x, rect.y, rectW, rectH, before);
        if (created) layer.cels.delete(frame);
      },
    });
  }

  private paintStamps(stamps: Stamp[]) {
    if (stamps.length === 0 || !this.strokeBrush) return;
    const target = this.strokeUsesWet ? this.renderer.scratch('wetStroke') : this.strokeCel?.surface;
    if (!target) return;
    for (const s of stamps) expandRect(this.strokeRect, s.x, s.y, s.size * 0.75 + 2);
    this.renderer.drawStamps(target, stamps, this.strokeColor, this.brushTexture(this.strokeBrush), this.strokeBrush.erase);
    this.renderAndPresent();
  }

  /** The wet surface composited live on top of the active layer's cel,
   *  while a non-erase stroke is in progress — see `renderAndPresent`
   *  and `Renderer.renderDocumentFrame`'s `wetOverlay` param. `undefined`
   *  the rest of the time, which renders exactly as before task 2.10. */
  private activeStrokeOverlay(): { layerId: string; surface: Surface } | undefined {
    if (!this.builder || !this.strokeUsesWet || !this.strokeLayer) return undefined;
    return { layerId: this.strokeLayer.id, surface: this.renderer.scratch('wetStroke') };
  }

  /** Clears the active layer's cel, undoably. A no-op (no history entry)
   *  on a layer with nothing to clear — clicking Clear on a blank layer
   *  shouldn't leave a phantom empty cel behind for undo to trip over. */
  clearActiveLayer() {
    const layer = this.activeLayer;
    const cel = celAt(layer, this._currentFrame);
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
    // Captured once, up front: this fill is asynchronous (the worker
    // round trip below), so the timeline could in principle move on
    // before it resolves — the fill must still land on the frame it was
    // requested on, not wherever the playhead ends up by the time the
    // worker replies.
    const frame = this._currentFrame;

    const reference = this.renderer.readRect(this.renderer.renderDocumentFrame(this.doc, frame), 0, 0, w, h);
    const { cel, created } = this.ensureCel(layer, frame);
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
        if (created) layer.cels.set(frame, cel);
        this.renderer.writeRect(cel.surface, rect.x, rect.y, rectW, rectH, sub);
      },
      undo: () => {
        this.renderer.writeRect(cel.surface, rect.x, rect.y, rectW, rectH, before);
        if (created) layer.cels.delete(frame);
      },
    };
    // `run`, not `push`: unlike a stroke, nothing has actually been
    // written to the GPU yet — `redo()` is what performs the fill.
    this.history.run(cmd);
    this.renderAndPresent();
  }

  /** Onion skin (task 2.14): when enabled, the previous frame's composite
   *  is drawn underneath the current one at reduced opacity — a plain
   *  `drawOver` at `ONION_OPACITY`, no shader change needed. Both frames
   *  are rendered with `paperAlpha` forced to 0 (a shallow-cloned doc,
   *  not a renderer change) so the paper itself is only painted once, as
   *  the base of the accumulator — otherwise the ghost frame's own opaque
   *  paper would completely hide it under the current frame's paper.
   *  `renderDocumentFrame`'s two calls below are safe back to back only
   *  because the ghost is drawn onto `acc` (a scratch under its own name,
   *  'onionAcc') before the second call reuses the renderer's internal
   *  accumulator scratches — see that method's own doc comment on why
   *  holding two results across a second call otherwise aliases. */
  renderAndPresent() {
    const overlay = this.activeStrokeOverlay();
    let result: Surface;
    if (this._onionSkin && this._currentFrame > 0) {
      const acc = this.renderer.scratch('onionAcc');
      if (this.doc.paperAlpha > 0) this.renderer.fill(acc, this.doc.paper, this.doc.paperAlpha);
      else this.renderer.clear(acc);

      const transparentDoc = this.doc.paperAlpha > 0 ? { ...this.doc, paperAlpha: 0 } : this.doc;
      const ghost = this.renderer.renderDocumentFrame(transparentDoc, this._currentFrame - 1);
      this.renderer.drawOver(acc, ghost, Engine.ONION_OPACITY);

      const current = this.renderer.renderDocumentFrame(transparentDoc, this._currentFrame, overlay);
      this.renderer.drawOver(acc, current, 1);
      result = acc;
    } else {
      result = this.renderer.renderDocumentFrame(this.doc, this._currentFrame, overlay);
    }
    const canvas = this.renderer.canvas;
    const viewMatrix = mat3FromTRS(0, 0, 0, canvas.width, canvas.height);
    this.renderer.present(result, viewMatrix, this.doc.paper, this.doc.paperAlpha, 16);
    this._revision++;
    for (const fn of this.revisionListeners) fn();
  }
}
