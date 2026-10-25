import { useEffect, useRef, useState } from 'react';
import type { Engine } from '../gl/engine';
import { CameraCapture } from '../native/cameraCapture';
import { CameraIcon, LockIcon, UnlockIcon } from './icons';

/** How many frames either side of the playhead the filmstrip draws. A
 *  windowed strip, not a virtualized scroller: a stop-motion project is
 *  hundreds of frames, and only the neighborhood of the playhead is what
 *  you look at while shooting. Prev/next and the counter in `Timeline`
 *  reach the rest. */
const FILMSTRIP_RADIUS = 10;

/**
 * Capture UI (task 2.3): the shutter, the exposure/focus lock, and the
 * filmstrip. Onion skin and frame stepping already live in `Timeline`
 * (task 2.14); this adds the camera-dependent half. Same subscription
 * pattern as `Timeline`/`LayersPanel` — mounted only once `DrawingCanvas`
 * has a live `Engine`.
 */
export function CapturePanel({ engine }: { engine: Engine }) {
  const [, forceUpdate] = useState(0);
  useEffect(() => engine.subscribe(() => forceUpdate((v) => v + 1)), [engine]);
  const [locked, setLocked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function toggleLock() {
    setError(null);
    try {
      if (locked) await CameraCapture.unlockCaptureSettings();
      else await CameraCapture.lockCaptureSettings();
      setLocked(!locked);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function shoot() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const { base64 } = await CameraCapture.capturePhoto();
      const blob = await (await fetch(`data:image/jpeg;base64,${base64}`)).blob();
      const bitmap = await createImageBitmap(blob);
      engine.captureFrame(bitmap);
      bitmap.close();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const frameCount = engine.doc.frameCount;
  const current = engine.currentFrame;
  const first = Math.max(0, current - FILMSTRIP_RADIUS);
  const last = Math.min(frameCount - 1, current + FILMSTRIP_RADIUS);
  const frames: number[] = [];
  for (let f = first; f <= last; f++) frames.push(f);

  return (
    <>
      <div className="cl-rail cl-filmstrip" role="list" aria-label="Filmstrip">
        {frames.map((f) => (
          <FrameThumb key={f} engine={engine} frame={f} current={f === current} />
        ))}
      </div>

      <div className="cl-rail cl-rail--capture">
        <button
          className="cl-railbtn"
          aria-pressed={locked}
          onClick={toggleLock}
          aria-label="Lock exposure and focus"
          title={locked ? 'Exposure and focus locked' : 'Lock exposure and focus'}
        >
          {locked ? <LockIcon /> : <UnlockIcon />}
        </button>
        <button className="cl-shutter" onClick={shoot} disabled={busy} aria-label="Shutter" title="Take photo">
          <CameraIcon size={22} />
        </button>
        {error && (
          <p className="cl-capture-error" role="alert">
            {error}
          </p>
        )}
      </div>
    </>
  );
}

function FrameThumb({ engine, frame, current }: { engine: Engine; frame: number; current: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  // `engine.revision` is deliberately not a dependency: `frameThumbnail`
  // keeps its own per-frame cache key, so redrawing on every revision is
  // cheap when nothing this frame shows has changed.
  const revision = engine.revision;
  useEffect(() => {
    const target = ref.current;
    if (!target) return;
    const thumb = engine.frameThumbnail(frame);
    if (target.width !== thumb.width) target.width = thumb.width;
    if (target.height !== thumb.height) target.height = thumb.height;
    target.getContext('2d')!.drawImage(thumb, 0, 0);
  }, [engine, frame, revision]);

  return (
    <button
      role="listitem"
      className={`cl-thumb${current ? ' is-current' : ''}`}
      onClick={() => engine.setCurrentFrame(frame)}
      aria-label={`Frame ${frame + 1}`}
      aria-current={current ? 'true' : undefined}
    >
      <canvas ref={ref} />
      <span className="cl-thumb__num">{frame + 1}</span>
    </button>
  );
}
