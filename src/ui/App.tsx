import { useState } from 'react';
import { CameraCapture } from '../native/cameraCapture';
import { FORMAT_PRESETS, type FormatPreset } from '../core/projectPresets';
import { DrawingCanvas } from './DrawingCanvas';
import { PersistenceHarness } from './PersistenceHarness';
import { RendererHarness } from './RendererHarness';

export function App() {
  const [frames, setFrames] = useState<string[]>([]);
  const [locked, setLocked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Starting a new project means throwing away the whole canvas/Engine/
  // Renderer and mounting a fresh one — see DrawingCanvas's own doc
  // comment on `preset`/`onNewProject` for why that's a `key` change
  // (a real React remount) rather than something DrawingCanvas resizes
  // itself into. `preset` alone isn't enough of a key on its own: picking
  // the SAME preset twice in a row (starting over on the same format)
  // should still reset the project, so a separate counter tracks "which
  // project" independently of "which format".
  const [preset, setPreset] = useState<FormatPreset>(FORMAT_PRESETS[0]);
  const [projectEpoch, setProjectEpoch] = useState(0);
  const handleNewProject = (next: FormatPreset) => {
    setPreset(next);
    setProjectEpoch((e) => e + 1);
  };

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
      <DrawingCanvas key={projectEpoch} preset={preset} onNewProject={handleNewProject} />

      {/* Manual test harnesses for tasks 1.2/1.3 (camera plugin skeleton),
          2.2 (renderer), and 2.5 (persistence) — collapsed by default so
          they don't visually compete with the actual drawing screen above
          (task 2.11). Deliberately left unstyled: these are dev tools, not
          product surface — see CLAUDE.md on why the camera plugin can't be
          verified from here at all (no device). */}
      <details style={{ margin: '16px auto', maxWidth: 480, color: '#9a9aa2', fontFamily: '-apple-system, sans-serif', fontSize: 13 }}>
        <summary style={{ cursor: 'pointer' }}>Developer tools (camera plugin, renderer, persistence harnesses)</summary>
        <div style={{ marginTop: 12 }}>
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
          <PersistenceHarness />
        </div>
      </details>
    </div>
  );
}
