import { useEffect, useRef, useState } from 'react';
import { DEFAULT_BRUSHES, StrokeBuilder } from '../core/brush';
import { newDocument, newLayer } from '../core/document';
import { mat3FromTRS } from '../core/math';
import type { InputSample } from '../core/types';
import { Renderer } from '../gl/renderer';

/**
 * Manual test harness for task 2.2 (the WebGL2 renderer). Builds a tiny
 * synthetic document — one camera cel (a four-color synthetic "photo",
 * standing in for `CameraCapture.capturePhoto()`) and one drawn cel (a
 * real pencil stroke through `brush.ts`'s `StrokeBuilder`) — and
 * composites them, so the pipeline can be checked by eye here and
 * pixel-checked headlessly by `npm run test:renderer-smoke`
 * (`scripts/renderer-smoke.mjs`, via `window.__clumsyloop`) without
 * needing the real capture UI (task 2.3) or a physical camera.
 *
 * The four quadrant colors exist to catch an orientation flip (uploading
 * a photo and reading it back must agree on which edge is "top") — a
 * solid-color photo couldn't tell top-left from bottom-right.
 */
export function RendererHarness() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [status, setStatus] = useState('Rendering…');

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const doc = newDocument(360, 640, 12, 1);
    const renderer = new Renderer(canvas);
    renderer.setDocumentSize(doc.width, doc.height);

    const cameraLayer = newLayer('Camera', true, 'camera');
    const photoSurface = renderer.createSurface('photo');
    const photoCanvas = window.document.createElement('canvas');
    photoCanvas.width = doc.width;
    photoCanvas.height = doc.height;
    const pctx = photoCanvas.getContext('2d')!;
    const halfW = doc.width / 2;
    const halfH = doc.height / 2;
    pctx.fillStyle = '#3b6fd6'; // top-left
    pctx.fillRect(0, 0, halfW, halfH);
    pctx.fillStyle = '#d63b6f'; // top-right
    pctx.fillRect(halfW, 0, halfW, halfH);
    pctx.fillStyle = '#6fd63b'; // bottom-left
    pctx.fillRect(0, halfH, halfW, halfH);
    pctx.fillStyle = '#d6c93b'; // bottom-right
    pctx.fillRect(halfW, halfH, halfW, halfH);
    renderer.uploadImage(photoSurface, photoCanvas);
    cameraLayer.cels.set(0, { id: 'photo-cel', surface: photoSurface });
    doc.layers.push(cameraLayer);

    const drawLayer = newLayer('Ink', true, 'draw');
    const inkSurface = renderer.createSurface('ink');
    const pencil = DEFAULT_BRUSHES.find((b) => b.id === 'pencil')!;
    const builder = new StrokeBuilder(pencil);
    const sample = (x: number, y: number, t: number): InputSample => ({
      x,
      y,
      pressure: 1,
      altitude: 0,
      azimuth: 0,
      time: t,
    });
    const cx = doc.width / 2;
    const cy = doc.height / 2;
    const stamps = [
      ...builder.begin(sample(cx - 60, cy, 0)),
      ...builder.push(sample(cx, cy, 40)),
      ...builder.push(sample(cx + 60, cy, 80)),
      ...builder.end(),
    ];
    renderer.drawStamps(inkSurface, stamps, { r: 0.1, g: 0.1, b: 0.1 });
    drawLayer.cels.set(0, { id: 'ink-cel', surface: inkSurface });
    doc.layers.push(drawLayer);

    const result = renderer.renderDocumentFrame(doc, 0);
    const viewMatrix = mat3FromTRS(0, 0, 0, canvas.width, canvas.height);
    renderer.present(result, viewMatrix, doc.paper, doc.paperAlpha, 16);

    (window as unknown as { __clumsyloop: unknown }).__clumsyloop = { renderer, doc, result };
    setStatus('Composited — camera photo + pencil stroke.');

    return () => {
      renderer.release(photoSurface);
      renderer.release(inkSurface);
    };
  }, []);

  return (
    <div>
      <h2>Renderer smoke test (task 2.2)</h2>
      <canvas
        ref={canvasRef}
        width={360}
        height={640}
        style={{ border: '1px solid #444', maxWidth: '100%', background: '#222' }}
      />
      <p>{status}</p>
    </div>
  );
}
