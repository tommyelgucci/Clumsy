import { useState } from 'react';
import type { Engine } from '../gl/engine';
import { canExportVideo, deliverVideo, exportVideo } from '../export/exportVideo';
import { ExportIcon } from './icons';

// Test hook, same convention as `__clumsyloopEngine`: lets the export
// smoke test render with and without the watermark and compare.
(window as unknown as { __clumsyloopExportVideo: typeof exportVideo }).__clumsyloopExportVideo = exportVideo;

/** The free plan is always assumed until entitlements exist (task 3.5,
 *  which gates this on the Firestore entitlement). */
const CLEAN_EXPORT_UNLOCKED = false;

/** Export to .mp4 (task 2.4): one button, a blocking progress overlay so
 *  nothing edits the document mid-render, and an error line if it fails. */
export function ExportButton({ engine }: { engine: Engine }) {
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const supported = canExportVideo();

  async function run() {
    setError(null);
    setProgress({ done: 0, total: 1 });
    try {
      const blob = await exportVideo(engine, {
        watermark: !CLEAN_EXPORT_UNLOCKED,
        onProgress: (done, total) => setProgress({ done, total }),
      });
      await deliverVideo(blob, 'clumsyloop.mp4');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setProgress(null);
    }
  }

  return (
    <>
      <button
        className="cl-railbtn"
        onClick={run}
        disabled={!supported || progress !== null}
        aria-label="Export video"
        title={supported ? 'Export .mp4' : 'Video export needs iOS 16.4 or newer'}
      >
        <ExportIcon />
      </button>
      {progress && (
        <div className="cl-export-overlay" role="status">
          Exporting frame {progress.done} of {progress.total}…
        </div>
      )}
      {error && (
        <div className="cl-export-overlay" role="alert" onClick={() => setError(null)}>
          Export failed: {error}
        </div>
      )}
    </>
  );
}
