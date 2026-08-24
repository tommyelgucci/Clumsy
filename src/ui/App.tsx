import { useEffect, useRef, useState } from 'react';
import { newDocument, newLayer } from '../core/document';
import { CameraCapture } from '../native/cameraCapture';
import { Renderer, type Surface } from '../gl/renderer';

/**
 * Synthetic "photo": four flat-color quadrants, opaque. Distinct colors per
 * corner make a Y-flip or transposed axis immediately visible in a
 * screenshot or a `readPixels` probe — a symmetric gradient wouldn't catch
 * that class of bug.
 */
function makeQuadrantPhoto(size: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const ctx = c.getContext('2d')!;
  const half = size / 2;
  ctx.fillStyle = '#e11d48'; // top-left: red
  ctx.fillRect(0, 0, half, half);
  ctx.fillStyle = '#16a34a'; // top-right: green
  ctx.fillRect(half, 0, half, half);
  ctx.fillStyle = '#2563eb'; // bottom-left: blue
  ctx.fillRect(0, half, half, half);
  ctx.fillStyle = '#eab308'; // bottom-right: yellow
  ctx.fillRect(half, half, half, half);
  return c;
}

/**
 * Synthetic "drawing": a soft-edged white circle at partial opacity. The
 * antialiased edge is the actual test — premultiplying incorrectly on
 * upload shows up as a dark/black fringe there, not in the flat interior.
 */
function makeSoftDot(size: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const ctx = c.getContext('2d')!;
  const r = size * 0.35;
  const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, r);
  grad.addColorStop(0, 'rgba(255,255,255,0.9)');
  grad.addColorStop(0.7, 'rgba(255,255,255,0.9)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  return c;
}

/**
 * Synthetic "drawn cel": a flat opaque square at `(x, y)`, rest fully
 * transparent — hard edges on purpose (no antialiasing to account for), so
 * a `readPixels` probe well inside or well outside the square gets an exact
 * expected color, not an approximation.
 */
function makeSquare(size: number, color: string, x: number, y: number, side = 40): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = color;
  ctx.fillRect(x, y, side, side);
  return c;
}

/**
 * Manual test harness for the onion-skin renderer primitive
 * (`Renderer.renderOnionSkin`) — a RoughAnimator-style feature that's
 * relevant to Clumsyloop's own drawing+camera differentiator, not just
 * Trace (see RUMBO.md). Three frames on a single mostly-transparent draw
 * layer, each with a square in a different corner, so the ghost tint math
 * is checkable by exact pixel readback rather than eyeballing a screenshot
 * — see `scripts/composite-check.mjs`'s onion-skin section for why the
 * squares don't overlap the current frame's own square.
 */
function OnionSkinHarness() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const size = 256;
    canvas.width = size;
    canvas.height = size;

    const renderer = new Renderer(canvas);
    const doc = newDocument(size, size, 12, 3);

    const drawLayer = newLayer('Drawing', true, 'draw');
    const frames: [number, string, number, number][] = [
      [0, '#16a34a', 20, 20], // frame 0: green, top-left
      [1, '#ffffff', 196, 20], // frame 1 (current, under test): white, top-right
      [2, '#2563eb', 20, 196], // frame 2: blue, bottom-left
    ];
    for (const [frame, color, x, y] of frames) {
      const surface = renderer.createSurface(size, size);
      renderer.uploadImage(surface, makeSquare(size, color, x, y));
      drawLayer.cels.set(frame, { id: `cel-${frame}`, surface });
    }
    doc.layers = [drawLayer];

    let lastSurface: Surface | null = null;
    const render = () => {
      lastSurface = renderer.renderOnionSkin(doc, 1, {
        before: 1,
        after: 1,
        beforeTint: { r: 1, g: 0, b: 0 }, // red, standard "before" onion tint
        afterTint: { r: 0, g: 1, b: 1 }, // cyan, standard "after" onion tint
        opacity: 0.4,
      });
      renderer.present(lastSurface, doc.paper, doc.paperAlpha);
    };
    render();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).__clumsyOnion = {
      renderer,
      doc,
      gl: renderer.gl,
      render,
      get lastSurface() {
        return lastSurface;
      },
    };
  }, []);

  return <canvas ref={canvasRef} className="onion-canvas" style={{ width: 256, height: 256 }} />;
}

/**
 * Manual test harness for task 2.2 (WebGL2 compositing renderer) — builds a
 * document with one camera Cel and one drawn Cel on top, renders it, and
 * exposes `window.__clumsy` so `scripts/composite-check.mjs` can drive
 * blend-mode changes and read back pixels. Not the real capture/drawing UI.
 */
function RendererHarness() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const size = 256;
    canvas.width = size;
    canvas.height = size;

    const renderer = new Renderer(canvas);
    const doc = newDocument(size, size, 12, 1);

    const cameraLayer = newLayer('Camera', true, 'camera');
    const cameraSurface = renderer.createSurface(size, size);
    renderer.uploadImage(cameraSurface, makeQuadrantPhoto(size));
    cameraLayer.cels.set(0, { id: 'cel-camera', surface: cameraSurface });

    const drawLayer = newLayer('Drawing', true, 'draw');
    drawLayer.opacity = 0.85;
    const drawSurface = renderer.createSurface(size, size);
    renderer.uploadImage(drawSurface, makeSoftDot(size));
    drawLayer.cels.set(0, { id: 'cel-draw', surface: drawSurface });

    doc.layers = [cameraLayer, drawLayer];

    let lastSurface: Surface | null = null;
    const render = () => {
      lastSurface = renderer.renderDocument(doc, 0);
      renderer.present(lastSurface, doc.paper, doc.paperAlpha);
    };
    render();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).__clumsy = {
      renderer,
      doc,
      gl: renderer.gl,
      render,
      get lastSurface() {
        return lastSurface;
      },
    };
  }, []);

  return <canvas ref={canvasRef} className="composite-canvas" style={{ width: 256, height: 256 }} />;
}

// Manual test harness for tasks 1.2/1.3 (the camera plugin skeleton and
// its exposure/focus lock) — not the real capture UI, which lands in
// phase 2 once 1.3's flicker check passes on a device.
export function App() {
  const [frames, setFrames] = useState<string[]>([]);
  const [locked, setLocked] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleLock() {
    setError(null);
    try {
      await CameraCapture.lockCaptureSettings();
      setLocked(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleUnlock() {
    setError(null);
    try {
      await CameraCapture.unlockCaptureSettings();
      setLocked(false);
      setFrames([]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleCapture() {
    setError(null);
    try {
      const { base64 } = await CameraCapture.capturePhoto();
      setFrames((prev) => [...prev, base64]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div>
      <button onClick={handleLock} disabled={locked}>
        Lock exposure/focus
      </button>
      <button onClick={handleUnlock} disabled={!locked}>
        Unlock
      </button>
      <button onClick={handleCapture}>Capture frame ({frames.length})</button>
      {error && <p>{error}</p>}
      <div>
        {frames.map((base64, i) => (
          <img key={i} src={`data:image/jpeg;base64,${base64}`} alt={`Frame ${i + 1}`} />
        ))}
      </div>
      <hr />
      <RendererHarness />
      <hr />
      <OnionSkinHarness />
    </div>
  );
}
