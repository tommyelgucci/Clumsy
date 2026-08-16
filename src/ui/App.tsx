import { useState } from 'react';
import { CameraCapture } from '../native/cameraCapture';

// Manual test harness for task 1.2 (the camera plugin skeleton) — not the
// real capture UI, which lands in phase 2 once 1.3 locks exposure/focus.
export function App() {
  const [photoBase64, setPhotoBase64] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleCapture() {
    setError(null);
    try {
      const { base64 } = await CameraCapture.capturePhoto();
      setPhotoBase64(base64);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div>
      <button onClick={handleCapture}>Capture photo</button>
      {error && <p>{error}</p>}
      {photoBase64 && <img src={`data:image/jpeg;base64,${photoBase64}`} alt="Captured frame" />}
    </div>
  );
}
