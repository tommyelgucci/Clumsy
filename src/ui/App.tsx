import { useState } from 'react';
import { CameraCapture } from '../native/cameraCapture';

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
    </div>
  );
}
