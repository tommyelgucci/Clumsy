import { useCallback, useEffect, useState } from 'react';
import { signIn } from '../cloud/auth';
import type { CloudUser } from '../cloud/auth';
import { REPORT_REASONS, type ClipRecord, type ReportReason } from '../cloud/clipModel';
import { blockUser, deleteOwnClip, fetchFeedPage, reportClip, type FeedPage } from '../cloud/clips';
import { CloseIcon } from './icons';

/**
 * The feed (task 4.2): newest first, no ranking, public to read. Each clip
 * can be reported or its author blocked, and your own can be deleted —
 * Apple's UGC requirements (task 5.1), done in the clip's own card so the
 * affordance is wherever the content is. A reported clip or blocked author
 * disappears from this list immediately, before the server has done
 * anything, since that's what the person asked for.
 */
export function Feed({ user, onClose }: { user: CloudUser | null; onClose: () => void }) {
  const [clips, setClips] = useState<ClipRecord[]>([]);
  const [page, setPage] = useState<Pick<FeedPage, 'cursor' | 'done'>>({ cursor: null, done: false });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reporting, setReporting] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async (cursor: FeedPage['cursor'], replace: boolean) => {
    setLoading(true);
    setError(null);
    try {
      const next = await fetchFeedPage(cursor);
      setClips((prev) => (replace ? next.clips : [...prev, ...next.clips]));
      setPage({ cursor: next.cursor, done: next.done });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  // Reload when the signed-in person changes: the block list that filters
  // the feed is theirs.
  const uid = user?.uid ?? null;
  useEffect(() => {
    void load(null, true);
  }, [load, uid]);

  async function guarded(action: () => Promise<void>) {
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  const report = (clip: ClipRecord, reason: ReportReason) =>
    guarded(async () => {
      await reportClip(clip.id, reason);
      setClips((prev) => prev.filter((c) => c.id !== clip.id));
      setReporting(null);
      setNotice('Reported. The clip is hidden while it is reviewed.');
    });

  const block = (clip: ClipRecord) =>
    guarded(async () => {
      await blockUser(clip.ownerId);
      setClips((prev) => prev.filter((c) => c.ownerId !== clip.ownerId));
      setNotice('Blocked. You will not see their clips.');
    });

  const remove = (clip: ClipRecord) =>
    guarded(async () => {
      await deleteOwnClip(clip);
      setClips((prev) => prev.filter((c) => c.id !== clip.id));
    });

  return (
    <div className="cl-feed" role="dialog" aria-label="Feed">
      <header className="cl-feed__bar">
        <h2 className="cl-feed__title">Feed</h2>
        {!user && (
          <button className="cl-btn" onClick={() => guarded(signIn)}>
            Sign in
          </button>
        )}
        <button className="cl-railbtn" onClick={onClose} aria-label="Close feed" title="Close">
          <CloseIcon size={16} />
        </button>
      </header>
      {error && <p className="cl-feed__msg cl-modal__error" role="alert">{error}</p>}
      {notice && <p className="cl-feed__msg" role="status">{notice}</p>}
      <ul className="cl-feed__list">
        {clips.map((clip) => (
          <li key={clip.id} className="cl-clip" data-clip-id={clip.id}>
            <video className="cl-clip__video" src={clip.videoUrl} controls playsInline loop preload="metadata" />
            {clip.caption && <p className="cl-clip__caption">{clip.caption}</p>}
            <div className="cl-clip__meta">{new Date(clip.createdAtMs).toLocaleDateString()}</div>
            {reporting === clip.id ? (
              <div className="cl-clip__reasons" role="group" aria-label="Report reason">
                {REPORT_REASONS.map((r) => (
                  <button key={r.id} className="cl-btn" onClick={() => report(clip, r.id)}>
                    {r.label}
                  </button>
                ))}
                <button className="cl-btn" onClick={() => setReporting(null)}>
                  Cancel
                </button>
              </div>
            ) : (
              <div className="cl-clip__actions">
                {user && user.uid === clip.ownerId ? (
                  <button className="cl-btn" onClick={() => remove(clip)}>
                    Delete
                  </button>
                ) : (
                  <>
                    <button className="cl-btn" onClick={() => (user ? setReporting(clip.id) : guarded(signIn))}>
                      Report
                    </button>
                    <button className="cl-btn" onClick={() => (user ? block(clip) : guarded(signIn))}>
                      Block author
                    </button>
                  </>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>
      {loading && <p className="cl-feed__msg" role="status">Loading…</p>}
      {!loading && clips.length === 0 && !error && <p className="cl-feed__msg">Nothing here yet.</p>}
      {!loading && !page.done && clips.length > 0 && (
        <button className="cl-btn cl-feed__more" onClick={() => load(page.cursor, false)}>
          Load more
        </button>
      )}
    </div>
  );
}
