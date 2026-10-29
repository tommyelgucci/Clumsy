import { useState } from 'react';
import { MAX_CAPTION_LENGTH, normalizeCaption } from '../cloud/clipModel';
import { publishClip } from '../cloud/clips';
import { signIn } from '../cloud/auth';
import type { CloudUser } from '../cloud/auth';
import { lastContentFrame } from '../core/document';
import { exportVideo } from '../export/exportVideo';
import type { Engine } from '../gl/engine';

type Phase = { kind: 'idle' } | { kind: 'working'; label: string } | { kind: 'done' } | { kind: 'error'; message: string };

/** Publish flow (tasks 4.1/4.3): caption, then export and upload in one go
 *  without leaving the editor. The export is the same one the Export
 *  button makes, so the watermark follows the same plan rule. */
export function PublishDialog({ engine, user, cleanExport, onClose }: { engine: Engine; user: CloudUser | null; cleanExport: boolean; onClose: () => void }) {
  const [caption, setCaption] = useState('');
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const busy = phase.kind === 'working';

  async function publish() {
    try {
      setPhase({ kind: 'working', label: 'Rendering…' });
      const blob = await exportVideo(engine, {
        watermark: !cleanExport,
        onProgress: (done, total) => setPhase({ kind: 'working', label: `Rendering frame ${done} of ${total}…` }),
      });
      setPhase({ kind: 'working', label: 'Uploading…' });
      await publishClip(
        blob,
        {
          caption,
          width: engine.doc.width & ~1,
          height: engine.doc.height & ~1,
          fps: engine.doc.fps,
          frames: lastContentFrame(engine.doc) + 1,
        },
        (fraction) => setPhase({ kind: 'working', label: `Uploading ${Math.round(fraction * 100)}%…` }),
      );
      setPhase({ kind: 'done' });
    } catch (err) {
      setPhase({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  }

  async function handleSignIn() {
    try {
      await signIn();
    } catch (err) {
      setPhase({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  }

  return (
    <div className="cl-modal" role="dialog" aria-label="Publish clip">
      <div className="cl-modal__card">
        <h2 className="cl-modal__title">Publish to the feed</h2>
        {phase.kind === 'done' ? (
          <>
            <p>Published.</p>
            <div className="cl-modal__actions">
              <button className="cl-btn cl-btn--primary" onClick={onClose}>
                Done
              </button>
            </div>
          </>
        ) : !user ? (
          <>
            <p>Sign in to publish.</p>
            {phase.kind === 'error' && <p className="cl-modal__error">{phase.message}</p>}
            <div className="cl-modal__actions">
              <button className="cl-btn" onClick={onClose}>
                Cancel
              </button>
              <button className="cl-btn cl-btn--primary" onClick={handleSignIn}>
                Sign in
              </button>
            </div>
          </>
        ) : (
          <>
            <label className="cl-modal__field">
              <span>Caption (optional)</span>
              <textarea
                value={caption}
                maxLength={MAX_CAPTION_LENGTH}
                rows={2}
                disabled={busy}
                onChange={(e) => setCaption(e.target.value)}
                onBlur={() => setCaption(normalizeCaption(caption))}
              />
            </label>
            {busy && <p role="status">{phase.label}</p>}
            {phase.kind === 'error' && <p className="cl-modal__error" role="alert">{phase.message}</p>}
            <div className="cl-modal__actions">
              <button className="cl-btn" onClick={onClose} disabled={busy}>
                Cancel
              </button>
              <button className="cl-btn cl-btn--primary" onClick={publish} disabled={busy}>
                Publish
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
