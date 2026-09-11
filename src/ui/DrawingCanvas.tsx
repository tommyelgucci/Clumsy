import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { BRUSH_CATEGORIES, BRUSH_CATEGORY_LABELS, DEFAULT_BRUSHES, type BrushPreset } from '../core/brush';
import { newDocument, newLayer } from '../core/document';
import { clamp, hexToRgb, rgbToHex } from '../core/math';
import type { InputSample, RGB } from '../core/types';
import { Engine } from '../gl/engine';
import { Renderer } from '../gl/renderer';
import { usePalettes } from '../state/palettes';
import { useTool } from '../state/tool';

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
 * Single fixed "Ink" layer, single frame: the capture UI's timeline
 * (task 2.3) and its camera layer are still blocked on device
 * verification (see CLAUDE.md) — this only needs the drawing half,
 * which was always independent of the camera.
 */
export function DrawingCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<Engine | null>(null);
  const [ready, setReady] = useState(false);
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
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const x = (e.clientX - rect.left) * scaleX;
    const y = (e.clientY - rect.top) * scaleY;

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
    <div>
      <h2>Drawing</h2>
      <canvas
        ref={canvasRef}
        id="drawing-canvas"
        width={DOC_WIDTH}
        height={DOC_HEIGHT}
        style={{ border: '1px solid #444', maxWidth: '100%', touchAction: 'none', cursor: 'crosshair' }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={endStroke}
        onPointerCancel={endStroke}
      />
      <p>{ready ? 'Ready.' : 'Starting…'}</p>

      <div>
        <button onClick={handleClear}>Clear</button>
        <button onClick={() => engineRef.current?.undo()} disabled={!canUndo} title="Ctrl/Cmd+Z">
          Undo{canUndo ? ` (${history!.undoLabel})` : ''}
        </button>
        <button onClick={() => engineRef.current?.redo()} disabled={!canRedo} title="Shift+Ctrl/Cmd+Z">
          Redo{canRedo ? ` (${history!.redoLabel})` : ''}
        </button>
      </div>

      <div>
        <h3>Tool</h3>
        <button onClick={() => setMode('draw')} aria-pressed={mode === 'draw'} style={{ fontWeight: mode === 'draw' ? 'bold' : 'normal' }}>
          Draw
        </button>
        <button onClick={() => setMode('bucket')} aria-pressed={mode === 'bucket'} style={{ fontWeight: mode === 'bucket' ? 'bold' : 'normal' }}>
          Bucket
        </button>
        {mode === 'bucket' && (
          <div>
            <label>
              Tolerance {tolerance.toFixed(2)}
              <input type="range" min={0} max={1} step={0.01} value={tolerance} onChange={(e) => setTolerance(Number(e.target.value))} />
            </label>
            <label>
              Expand {expand}px
              <input type="range" min={0} max={8} step={1} value={expand} onChange={(e) => setExpand(Number(e.target.value))} />
            </label>
            <label>
              Gap closure {gapClose}px
              <input type="range" min={0} max={8} step={1} value={gapClose} onChange={(e) => setGapClose(Number(e.target.value))} />
            </label>
          </div>
        )}
      </div>

      <div>
        <h3>Brush</h3>
        {BRUSH_CATEGORIES.map((category) => (
          <div key={category}>
            <strong>{BRUSH_CATEGORY_LABELS[category]}</strong>
            <div>
              {DEFAULT_BRUSHES.filter((b) => b.category === category).map((brush) => (
                <button
                  key={brush.id}
                  onClick={() => setActiveBrush(brush.id)}
                  aria-pressed={brush.id === activeBrushId}
                  style={{ fontWeight: brush.id === activeBrushId ? 'bold' : 'normal' }}
                >
                  {brush.name}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>

      <div>
        <h3>Color</h3>
        <select value={paletteIndex} onChange={(e) => setPaletteIndex(Number(e.target.value))}>
          {paletteGroups.map((group, i) => (
            <option key={group.name} value={i}>
              {group.name}
            </option>
          ))}
        </select>
        <div>
          {paletteGroups[paletteIndex]?.colors.map((color, i) => (
            <button
              key={i}
              onClick={() => setActiveColor(color)}
              aria-label={rgbToHex(color)}
              style={{
                width: 24,
                height: 24,
                background: rgbToHex(color),
                border: color === activeColor ? '2px solid #fff' : '1px solid #888',
                outline: color === activeColor ? '1px solid #000' : 'none',
              }}
            />
          ))}
        </div>
        <input type="color" value={rgbToHex(activeColor)} onChange={(e) => setActiveColor(hexToRgb(e.target.value))} />
      </div>
    </div>
  );
}
