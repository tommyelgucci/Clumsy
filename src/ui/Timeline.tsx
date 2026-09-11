import { useEffect, useState } from 'react';
import type { Engine } from '../gl/engine';
import { DuplicateFrameIcon, OnionIcon, PlusIcon, StepBackIcon, StepForwardIcon, TrashIcon } from './icons';

/**
 * Frame transport (task 2.14): the camera-independent half of what task
 * 2.3 originally bundled as "onion skin, shutter, filmstrip" — the
 * shutter itself still needs the still-blocked native camera plugin, but
 * navigating, adding, duplicating, and deleting a draw-only frame need
 * nothing from the camera. Deliberately NOT a filmstrip: rendering a
 * thumbnail per frame would mean rasterizing every frame to a small
 * canvas on every document mutation, and nothing here needs that yet to
 * be useful — this is frame count and prev/next, the same information a
 * filmstrip would show, just as text instead of pictures. A real
 * filmstrip is future work, not an oversight.
 *
 * Same subscription pattern as `LayersPanel`: mounted only once
 * `DrawingCanvas` already has a live `Engine`, so a plain `useEffect`
 * subscription to `engine.subscribe()` is safe on first mount.
 */
export function Timeline({ engine }: { engine: Engine }) {
  const [, forceUpdate] = useState(0);
  useEffect(() => engine.subscribe(() => forceUpdate((v) => v + 1)), [engine]);

  const frame = engine.currentFrame;
  const frameCount = engine.doc.frameCount;
  const activeLayer = engine.doc.layers.find((l) => l.id === engine.activeLayerId);
  const hasCelHere = activeLayer?.cels.has(frame) ?? false;

  return (
    <div className="cl-rail cl-rail--bottom">
      <button className="cl-railbtn" onClick={() => engine.stepFrame(-1)} disabled={frame <= 0} aria-label="Previous frame" title="Previous frame">
        <StepBackIcon />
      </button>
      <span className="cl-frame-counter">
        {frame + 1} / {frameCount}
      </span>
      <button className="cl-railbtn" onClick={() => engine.stepFrame(1)} disabled={frame >= frameCount - 1} aria-label="Next frame" title="Next frame">
        <StepForwardIcon />
      </button>
      <span className="cl-rail-divider" />
      <button className="cl-railbtn" onClick={() => engine.addCel(false)} aria-label="New frame" title="New frame">
        <PlusIcon />
      </button>
      <button className="cl-railbtn" onClick={() => engine.addCel(true)} aria-label="Duplicate frame" title="Duplicate frame">
        <DuplicateFrameIcon />
      </button>
      <button
        className="cl-railbtn cl-railbtn--danger"
        onClick={() => engine.deleteCel()}
        disabled={!hasCelHere}
        aria-label="Delete frame"
        title="Delete frame"
      >
        <TrashIcon />
      </button>
      <span className="cl-rail-divider" />
      <button
        className="cl-railbtn"
        aria-pressed={engine.onionSkinEnabled}
        onClick={() => engine.setOnionSkin(!engine.onionSkinEnabled)}
        aria-label="Onion skin"
        title="Onion skin"
      >
        <OnionIcon />
      </button>
      <label className="cl-fps-input" title="Frames per second">
        <input
          type="number"
          min={1}
          max={60}
          value={engine.doc.fps}
          aria-label="Frames per second"
          onChange={(e) => engine.setFps(Number(e.target.value))}
        />
        <span aria-hidden="true">fps</span>
      </label>
    </div>
  );
}
