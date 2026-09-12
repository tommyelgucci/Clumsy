import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { BRUSH_CATEGORIES, BRUSH_CATEGORY_LABELS, DEFAULT_BRUSHES, type BrushPreset } from '../core/brush';
import { newDocument, newLayer } from '../core/document';
import { clamp, hexToRgb, rgbToHex } from '../core/math';
import { FORMAT_PRESETS, type FormatPreset } from '../core/projectPresets';
import type { InputSample, RGB } from '../core/types';
import { Engine } from '../gl/engine';
import { Renderer } from '../gl/renderer';
import './drawing.css';
import { FloatingPanel } from './FloatingPanel';
import { BucketIcon, CloseIcon, DuplicateFrameIcon, LassoIcon, LayersIcon, NewProjectIcon, PencilIcon, RedoIcon, TransformIcon, TrashIcon, UndoIcon } from './icons';
import { LayersPanel } from './LayersPanel';
import { Timeline } from './Timeline';
import { TransformPanel } from './TransformPanel';
import { usePalettes } from '../state/palettes';
import { useTool } from '../state/tool';

type PanelId = 'layers' | 'brush' | 'color' | 'project' | 'transform';

/** Tilt arrives in degrees; the brush engine wants radians — same
 *  conversion Trace's `ui/CanvasView.tsx` uses (`tiltToSpherical`). */
function tiltToSpherical(tiltX: number, tiltY: number) {
  const tx = (tiltX * Math.PI) / 180;
  const ty = (tiltY * Math.PI) / 180;
  const tanX = Math.tan(tx);
  const tanY = Math.tan(ty);
  const altitude = Math.atan2(1, Math.hypot(tanX, tanY));
  const azimuth = Math.atan2(tanY, tanX);
  return { altitude, azimuth };
}

/**
 * The real drawing surface — the first non-harness consumer of
 * `brush.ts`, `palettes.ts`, and the renderer's compositing pipeline.
 * Starts with a single "Ink" layer but the layers panel (task 2.9) lets
 * the user add/remove/reorder more, all `kind: 'draw'` — a camera layer's
 * cels only ever come from the capture UI's shutter (task 2.3), still
 * blocked on device verification (see CLAUDE.md). Multi-frame since task
 * 2.14: the `Timeline` rail lets the user navigate/add/duplicate/delete
 * draw-only frames — the camera-independent half of what task 2.3
 * originally bundled together (see that component's own doc comment).
 *
 * Layout (task 2.13): the canvas fills the whole screen; floating icon
 * rails (tools, undo/redo, panel toggles) and closeable overlay panels
 * (Layers/Brush/Color) sit on top of it, ported from the exact pattern
 * `tommyelgucci/draw` (Trace) already uses — see drawing.css's file
 * header for why this replaces task 2.12's docked-panel approach rather
 * than sitting alongside it.
 *
 * `preset`/`onNewProject` (task 2.15): the canvas format picker. This
 * component only renders the picker and reports the choice upward —
 * actually starting a fresh project means throwing away this whole
 * component's canvas/Engine/Renderer and mounting a new one, which is
 * simplest and safest done by having the parent change this component's
 * `key` (a standard React remount, not something this component can do
 * to itself): a brand-new `<canvas>` element gets its own isolated WebGL
 * context for free, with no need to build a `Renderer.dispose()` this
 * project has never needed before now. See `App.tsx` for the `key`/state
 * that actually does the remounting.
 */
export function DrawingCanvas({ preset = FORMAT_PRESETS[0], onNewProject }: { preset?: FormatPreset; onNewProject?: (preset: FormatPreset) => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<Engine | null>(null);
  const [ready, setReady] = useState(false);
  const [activePanel, setActivePanel] = useState<PanelId | null>(null);
  const togglePanel = (id: PanelId) => setActivePanel((p) => (p === id ? null : id));
  // Forces a re-render on every history change so the Undo/Redo buttons'
  // disabled state stays current — subscribed inside the same effect
  // that creates the engine (below), not via useSyncExternalStore: that
  // hook's own subscribe effect can run before the engine-creation
  // effect does, missing the subscription entirely on first mount.
  const [, forceHistoryUpdate] = useState(0);
  // Bumped after any engine call that changes `engine.selection` (it's
  // engine state, not React state, same reasoning as the document
  // itself — see CLAUDE.md) so the outline overlay below re-reads it.
  // Deliberately NOT a full `engine.subscribe()` — that fires on every
  // mutation, including every stamp of an in-progress stroke, and this
  // component doesn't need to re-render that often just to keep an
  // outline in sync.
  const [, forceSelectionUpdate] = useState(0);

  const mode = useTool((s) => s.mode);
  const setMode = useTool((s) => s.setMode);
  const activeBrushId = useTool((s) => s.activeBrushId);
  const activeColor = useTool((s) => s.activeColor);
  const setActiveBrush = useTool((s) => s.setActiveBrush);
  const setActiveColor = useTool((s) => s.setActiveColor);
  // Pointer handlers close over refs, not the reactive values, so
  // switching brush/color mid-stroke can't tear a stroke in half — a
  // stroke reads whatever was current when it began and keeps using it.
  const strokeBrushRef = useRef<BrushPreset>(DEFAULT_BRUSHES[0]);
  const strokeColorRef = useRef<RGB>(activeColor);
  strokeColorRef.current = activeColor;
  const modeRef = useRef(mode);
  modeRef.current = mode;
  useEffect(() => {
    strokeBrushRef.current = DEFAULT_BRUSHES.find((b) => b.id === activeBrushId) ?? DEFAULT_BRUSHES[0];
  }, [activeBrushId]);

  const paletteGroups = usePalettes((s) => s.paletteGroups);
  const [paletteIndex, setPaletteIndex] = useState(0);

  // Bucket fill's three knobs (see core/flood.ts): tolerance decides how
  // different a color can be and still count as "inside"; expand bleeds
  // the fill a few pixels past the line, to cover its antialiasing
  // sliver; gapClose is different from both — it lets the fill treat a
  // small real break in the line as still closed, instead of leaking
  // through it.
  const [tolerance, setTolerance] = useState(0.15);
  const [expand, setExpand] = useState(2);
  const [gapClose, setGapClose] = useState(2);
  const toleranceRef = useRef(tolerance);
  toleranceRef.current = tolerance;
  const expandRef = useRef(expand);
  expandRef.current = expand;
  const gapCloseRef = useRef(gapClose);
  gapCloseRef.current = gapClose;

  // `preset` is read once, at mount, on purpose: a size change is a brand
  // new project, and the parent (`App.tsx`) already handles that by
  // changing this whole component's `key` — a full remount with a fresh
  // canvas/Engine — rather than this effect resizing the existing one in
  // place. So this never needs to re-run when `preset` changes; it can't,
  // by construction (a new `preset` value only ever arrives via a remount
  // that recreates this effect's closure from scratch anyway).
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const doc = newDocument(preset.width, preset.height, 12, 24);
    const ink = newLayer('Ink', true, 'draw');
    doc.layers.push(ink);
    let engine: Engine;
    try {
      engine = new Engine(new Renderer(canvas), doc, ink.id);
    } catch (err) {
      console.error(err);
      return;
    }
    engineRef.current = engine;
    engine.renderAndPresent();
    setReady(true);
    (window as unknown as { __clumsyloopEngine: Engine; __clumsyloopTool: typeof useTool }).__clumsyloopEngine = engine;
    (window as unknown as { __clumsyloopEngine: Engine; __clumsyloopTool: typeof useTool }).__clumsyloopTool = useTool;
    const unsubscribeHistory = engine.history.subscribe(() => forceHistoryUpdate((v) => v + 1));

    return () => {
      unsubscribeHistory();
      engineRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keyboard shortcuts: Ctrl/Cmd+Z to undo, Shift+Ctrl/Cmd+Z (or Ctrl+Y)
  // to redo — the behavior any drawing app's users already expect.
  // Skipped while a form control has focus, so it doesn't fight the
  // palette dropdown or the native color input.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && /^(input|select|textarea)$/i.test(target.tagName)) return;
      if (e.key === 'Escape' && engineRef.current?.selection) {
        engineRef.current.clearSelection();
        forceSelectionUpdate((v) => v + 1);
        return;
      }
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key.toLowerCase() === 'z' && e.shiftKey) {
        e.preventDefault();
        engineRef.current?.redo();
      } else if (e.key.toLowerCase() === 'z') {
        e.preventDefault();
        engineRef.current?.undo();
      } else if (e.key.toLowerCase() === 'y') {
        e.preventDefault();
        engineRef.current?.redo();
      } else if (e.key.toLowerCase() === 'd' && engineRef.current?.selection) {
        e.preventDefault();
        engineRef.current.duplicateSelection();
        forceSelectionUpdate((v) => v + 1);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const drawingId = useRef<number | null>(null);

  const toSample = (e: { clientX: number; clientY: number; pressure: number; pointerType: string; tiltX?: number; tiltY?: number; timeStamp: number }): InputSample => {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    // The CSS box (`rect`) and the document's own pixels (`canvas.width`/
    // `canvas.height`) don't necessarily share an aspect ratio since the
    // layout pass (task 2.12) made the canvas `object-fit: contain` —
    // letting it fill a `.cl-canvas-wrap` of any shape on tablet/desktop
    // instead of sitting at its native 360x640 size in a sea of empty
    // space. `contain` can letterbox: the rendered content is centered
    // and scaled by whichever axis is more constraining, not stretched
    // to fill `rect` on both axes. A naive rect.width/rect.height scale
    // (correct only for the old max-width:100%;height:auto sizing, which
    // could never letterbox) would misplace every stroke on any screen
    // where the two aspect ratios differ — this recovers the actual
    // letterboxed content rect first.
    const scale = Math.min(rect.width / canvas.width, rect.height / canvas.height);
    const contentW = canvas.width * scale;
    const contentH = canvas.height * scale;
    const offsetX = rect.left + (rect.width - contentW) / 2;
    const offsetY = rect.top + (rect.height - contentH) / 2;
    const x = (e.clientX - offsetX) / scale;
    const y = (e.clientY - offsetY) / scale;

    // A mouse (or a pen not touching yet) reports pressure 0/0.5; without
    // this floor, pressure-driven size/opacity dynamics would draw
    // nothing at all with a mouse.
    let pressure = e.pointerType === 'mouse' ? 0.5 : e.pressure;
    if (pressure <= 0) pressure = 0.5;

    let altitude = Math.PI / 2;
    let azimuth = 0;
    if (e.tiltX || e.tiltY) {
      const s = tiltToSpherical(e.tiltX ?? 0, e.tiltY ?? 0);
      altitude = s.altitude;
      azimuth = s.azimuth;
    }

    return { x, y, pressure: clamp(pressure, 0.01, 1), altitude, azimuth, time: e.timeStamp || performance.now() };
  };

  // Lasso (task 2.17): a drag starting INSIDE the existing selection
  // moves it; a drag starting outside traces a new one. `lassoMoving`
  // tracks which of those two this gesture is, decided once at
  // pointerdown; `lassoPath` is the in-progress path's points, drawn
  // live by the SVG overlay below and only handed to the engine (as a
  // rasterized mask) once the gesture ends with `setLassoSelection`.
  const lassoMoving = useRef(false);
  const [lassoPath, setLassoPath] = useState<{ x: number; y: number }[]>([]);

  const handlePointerDown = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const engine = engineRef.current;
    if (!engine) return;
    const sample = toSample(e);
    if (modeRef.current === 'bucket') {
      // A fill is a single tap, not a drag — no pointer capture, no
      // stroke tracking, `pointermove`/`pointerup` stay no-ops for it.
      void engine.floodFill(sample.x, sample.y, strokeColorRef.current, toleranceRef.current, expandRef.current, gapCloseRef.current);
      return;
    }
    if (modeRef.current === 'lasso') {
      e.currentTarget.setPointerCapture(e.pointerId);
      drawingId.current = e.pointerId;
      if (engine.selectionContains(sample.x, sample.y)) {
        lassoMoving.current = true;
        engine.beginMoveSelection(sample);
      } else {
        lassoMoving.current = false;
        setLassoPath([{ x: sample.x, y: sample.y }]);
      }
      return;
    }
    e.currentTarget.setPointerCapture(e.pointerId);
    drawingId.current = e.pointerId;
    engine.beginStroke(strokeBrushRef.current, strokeColorRef.current, sample);
  };

  const handlePointerMove = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (drawingId.current !== e.pointerId) return;
    const sample = toSample(e);
    if (modeRef.current === 'lasso') {
      if (lassoMoving.current) engineRef.current?.moveSelectionTo(sample);
      else setLassoPath((prev) => [...prev, { x: sample.x, y: sample.y }]);
      return;
    }
    engineRef.current?.pushStroke(sample);
  };

  const endStroke = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (drawingId.current !== e.pointerId) return;
    drawingId.current = null;
    if (modeRef.current === 'lasso') {
      if (lassoMoving.current) {
        engineRef.current?.endMoveSelection();
        lassoMoving.current = false;
      } else {
        // Reads `lassoPath` directly rather than through a setLassoPath
        // updater function: React may invoke an updater more than once
        // or outside a plain event-handler context (its contract
        // requires updaters to be pure, side-effect-free), and
        // `setLassoSelection` is a real engine mutation that notifies
        // other subscribed components (Timeline) — doing that from
        // inside an updater produced exactly the "setState while
        // rendering a different component" warning React warns about.
        if (lassoPath.length >= 3) engineRef.current?.setLassoSelection(lassoPath);
        setLassoPath([]);
      }
      forceSelectionUpdate((v) => v + 1);
      return;
    }
    engineRef.current?.endStroke();
  };

  const handleDeselect = () => {
    engineRef.current?.clearSelection();
    forceSelectionUpdate((v) => v + 1);
  };

  const handleDuplicateSelection = () => {
    engineRef.current?.duplicateSelection();
    forceSelectionUpdate((v) => v + 1);
  };

  const handleClear = () => {
    engineRef.current?.clearActiveLayer();
  };

  const history = engineRef.current?.history;
  const canUndo = history?.canUndo ?? false;
  const canRedo = history?.canRedo ?? false;

  return (
    <div className="cl-app">
      <canvas
        ref={canvasRef}
        id="drawing-canvas"
        className="cl-canvas"
        width={preset.width}
        height={preset.height}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={endStroke}
        onPointerCancel={endStroke}
      />

      {/* Lasso outline (task 2.17): drawn in an SVG sharing the canvas's own
          viewBox-to-container scaling (`preserveAspectRatio="xMidYMid meet"`
          mirrors `object-fit: contain`), so document-space points can be
          used directly with no manual scale/offset math — unlike the
          pointer handlers above, which must convert the other direction
          (client to document space) since native pointer events only ever
          arrive in client coordinates. */}
      <svg className="cl-selection-overlay" viewBox={`0 0 ${preset.width} ${preset.height}`} preserveAspectRatio="xMidYMid meet">
        {lassoPath.length > 1 && <polyline className="cl-lasso-path" points={lassoPath.map((p) => `${p.x},${p.y}`).join(' ')} />}
        {engineRef.current?.selection && (
          <polygon className="cl-selection-outline" points={engineRef.current.selection.points.map((p) => `${p.x},${p.y}`).join(' ')} />
        )}
      </svg>

      <p className="cl-status">{ready ? 'Ready.' : 'Starting…'}</p>

      <div className="cl-rail cl-rail--left">
        <button className="cl-railbtn" aria-pressed={mode === 'draw'} onClick={() => setMode('draw')} aria-label="Draw" title="Draw">
          <PencilIcon />
        </button>
        <button className="cl-railbtn" aria-pressed={mode === 'bucket'} onClick={() => setMode('bucket')} aria-label="Bucket" title="Bucket fill">
          <BucketIcon />
        </button>
        <button className="cl-railbtn" aria-pressed={mode === 'lasso'} onClick={() => setMode('lasso')} aria-label="Lasso" title="Lasso select">
          <LassoIcon />
        </button>
        <button
          className="cl-colorwell"
          onClick={() => togglePanel('color')}
          aria-label="Color"
          aria-pressed={activePanel === 'color'}
          title="Color"
          style={{ background: rgbToHex(activeColor) }}
        />
        {mode === 'bucket' && (
          <>
            <span className="cl-rail-divider" />
            <div className="cl-rail__sliders">
              <label className="cl-slider-row">
                Tolerance {tolerance.toFixed(2)}
                <input type="range" min={0} max={1} step={0.01} value={tolerance} onChange={(e) => setTolerance(Number(e.target.value))} />
              </label>
              <label className="cl-slider-row">
                Expand {expand}px
                <input type="range" min={0} max={8} step={1} value={expand} onChange={(e) => setExpand(Number(e.target.value))} />
              </label>
              <label className="cl-slider-row">
                Gap closure {gapClose}px
                <input type="range" min={0} max={8} step={1} value={gapClose} onChange={(e) => setGapClose(Number(e.target.value))} />
              </label>
            </div>
          </>
        )}
        {mode === 'lasso' && engineRef.current?.selection && (
          <>
            <span className="cl-rail-divider" />
            <button className="cl-railbtn" onClick={handleDuplicateSelection} aria-label="Duplicate selection" title="Duplicate (Ctrl/Cmd+D)">
              <DuplicateFrameIcon size={16} />
            </button>
            <button className="cl-railbtn" onClick={handleDeselect} aria-label="Deselect" title="Deselect (Esc)">
              <CloseIcon size={16} />
            </button>
          </>
        )}
      </div>

      <div className="cl-rail cl-rail--top">
        {onNewProject && (
          <>
            <button className="cl-railbtn" aria-pressed={activePanel === 'project'} onClick={() => togglePanel('project')} aria-label="New project" title="New project">
              <NewProjectIcon />
            </button>
            <span className="cl-rail-divider" />
          </>
        )}
        <button className="cl-railbtn cl-railbtn--danger" onClick={handleClear} aria-label="Clear" title="Clear layer">
          <TrashIcon />
        </button>
        <button className="cl-railbtn" onClick={() => engineRef.current?.undo()} disabled={!canUndo} aria-label={`Undo${canUndo ? ` (${history!.undoLabel})` : ''}`} title="Ctrl/Cmd+Z">
          <UndoIcon />
        </button>
        <button className="cl-railbtn" onClick={() => engineRef.current?.redo()} disabled={!canRedo} aria-label={`Redo${canRedo ? ` (${history!.redoLabel})` : ''}`} title="Shift+Ctrl/Cmd+Z">
          <RedoIcon />
        </button>
        <span className="cl-rail-divider" />
        <button className="cl-railbtn" aria-pressed={activePanel === 'brush'} onClick={() => togglePanel('brush')} aria-label="Brush" title="Brush">
          <PencilIcon />
        </button>
        <button className="cl-railbtn" aria-pressed={activePanel === 'layers'} onClick={() => togglePanel('layers')} aria-label="Layers" title="Layers">
          <LayersIcon />
        </button>
        <button className="cl-railbtn" aria-pressed={activePanel === 'transform'} onClick={() => togglePanel('transform')} aria-label="Transform" title="Transform">
          <TransformIcon />
        </button>
      </div>

      {ready && engineRef.current && <Timeline engine={engineRef.current} />}

      {activePanel === 'transform' && ready && engineRef.current && (
        <FloatingPanel title="Transform" onClose={() => setActivePanel(null)}>
          <TransformPanel engine={engineRef.current} />
        </FloatingPanel>
      )}

      {activePanel === 'project' && onNewProject && (
        <FloatingPanel title="New project" onClose={() => setActivePanel(null)}>
          <p className="cl-section-title">Choose a format</p>
          <div className="cl-chip-group">
            <div className="cl-chip-row cl-chip-row--wrap">
              {FORMAT_PRESETS.map((p) => (
                <button
                  key={p.id}
                  className="cl-chip"
                  onClick={() => {
                    onNewProject(p);
                    setActivePanel(null);
                  }}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>
        </FloatingPanel>
      )}

      {activePanel === 'layers' && ready && engineRef.current && (
        <FloatingPanel title="Layers" onClose={() => setActivePanel(null)}>
          <LayersPanel engine={engineRef.current} />
        </FloatingPanel>
      )}

      {activePanel === 'brush' && (
        <FloatingPanel title="Brush" onClose={() => setActivePanel(null)}>
          {BRUSH_CATEGORIES.map((category) => (
            <div key={category} className="cl-chip-group">
              <span className="cl-chip-group-label">{BRUSH_CATEGORY_LABELS[category]}</span>
              <div className="cl-chip-row">
                {DEFAULT_BRUSHES.filter((b) => b.category === category).map((brush) => (
                  <button key={brush.id} className="cl-chip" onClick={() => setActiveBrush(brush.id)} aria-pressed={brush.id === activeBrushId}>
                    {brush.name}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </FloatingPanel>
      )}

      {activePanel === 'color' && (
        <FloatingPanel title="Color" onClose={() => setActivePanel(null)}>
          <select className="cl-palette-select" value={paletteIndex} onChange={(e) => setPaletteIndex(Number(e.target.value))}>
            {paletteGroups.map((group, i) => (
              <option key={group.name} value={i}>
                {group.name}
              </option>
            ))}
          </select>
          <div className="cl-swatch-row">
            {paletteGroups[paletteIndex]?.colors.map((color, i) => (
              <button
                key={i}
                className={`cl-swatch${color === activeColor ? ' cl-swatch--selected' : ''}`}
                onClick={() => setActiveColor(color)}
                aria-label={rgbToHex(color)}
                style={{ background: rgbToHex(color) }}
              />
            ))}
          </div>
          <input className="cl-color-input" type="color" value={rgbToHex(activeColor)} onChange={(e) => setActiveColor(hexToRgb(e.target.value))} />
        </FloatingPanel>
      )}
    </div>
  );
}
