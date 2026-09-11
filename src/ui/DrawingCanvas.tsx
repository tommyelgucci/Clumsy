import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { BRUSH_CATEGORIES, BRUSH_CATEGORY_LABELS, DEFAULT_BRUSHES, type BrushPreset } from '../core/brush';
import { newDocument, newLayer } from '../core/document';
import { clamp, hexToRgb, rgbToHex } from '../core/math';
import type { InputSample, RGB } from '../core/types';
import { Engine } from '../gl/engine';
import { Renderer } from '../gl/renderer';
import './drawing.css';
import { FloatingPanel } from './FloatingPanel';
import { BucketIcon, LayersIcon, PencilIcon, RedoIcon, TrashIcon, UndoIcon } from './icons';
import { LayersPanel } from './LayersPanel';
import { usePalettes } from '../state/palettes';
import { useTool } from '../state/tool';

type PanelId = 'layers' | 'brush' | 'color';

const DOC_WIDTH = 360;
const DOC_HEIGHT = 640;

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
 * blocked on device verification (see CLAUDE.md). Single frame regardless
 * of layer count: the timeline itself is also task 2.3's territory.
 *
 * Layout (task 2.13): the canvas fills the whole screen; floating icon
 * rails (tools, undo/redo, panel toggles) and closeable overlay panels
 * (Layers/Brush/Color) sit on top of it, ported from the exact pattern
 * `tommyelgucci/draw` (Trace) already uses — see drawing.css's file
 * header for why this replaces task 2.12's docked-panel approach rather
 * than sitting alongside it.
 */
export function DrawingCanvas() {
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

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const doc = newDocument(DOC_WIDTH, DOC_HEIGHT, 12, 1);
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
  }, []);

  // Keyboard shortcuts: Ctrl/Cmd+Z to undo, Shift+Ctrl/Cmd+Z (or Ctrl+Y)
  // to redo — the behavior any drawing app's users already expect.
  // Skipped while a form control has focus, so it doesn't fight the
  // palette dropdown or the native color input.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      const target = e.target as HTMLElement | null;
      if (target && /^(input|select|textarea)$/i.test(target.tagName)) return;
      if (e.key.toLowerCase() === 'z' && e.shiftKey) {
        e.preventDefault();
        engineRef.current?.redo();
      } else if (e.key.toLowerCase() === 'z') {
        e.preventDefault();
        engineRef.current?.undo();
      } else if (e.key.toLowerCase() === 'y') {
        e.preventDefault();
        engineRef.current?.redo();
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
    e.currentTarget.setPointerCapture(e.pointerId);
    drawingId.current = e.pointerId;
    engine.beginStroke(strokeBrushRef.current, strokeColorRef.current, sample);
  };

  const handlePointerMove = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (drawingId.current !== e.pointerId) return;
    engineRef.current?.pushStroke(toSample(e));
  };

  const endStroke = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (drawingId.current !== e.pointerId) return;
    drawingId.current = null;
    engineRef.current?.endStroke();
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
        width={DOC_WIDTH}
        height={DOC_HEIGHT}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={endStroke}
        onPointerCancel={endStroke}
      />

      <p className="cl-status">{ready ? 'Ready.' : 'Starting…'}</p>

      <div className="cl-rail cl-rail--left">
        <button className="cl-railbtn" aria-pressed={mode === 'draw'} onClick={() => setMode('draw')} aria-label="Draw" title="Draw">
          <PencilIcon />
        </button>
        <button className="cl-railbtn" aria-pressed={mode === 'bucket'} onClick={() => setMode('bucket')} aria-label="Bucket" title="Bucket fill">
          <BucketIcon />
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
      </div>

      <div className="cl-rail cl-rail--top">
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
      </div>

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
