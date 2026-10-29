import { useCallback, useEffect, useState } from 'react';
import { decide, errorCode, fetchQueue, signInAdmin, signOutAdmin, watchAdminUser, type Decision, type QueueItem } from './api';
import { dueStatus, tallyReasons } from './time';

type Load = { kind: 'loading' } | { kind: 'ready' } | { kind: 'denied' } | { kind: 'error'; message: string };

export function Panel() {
  const [uid, setUid] = useState<string | null | undefined>(undefined);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [clockSkew, setClockSkew] = useState(0);
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [notice, setNotice] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => watchAdminUser(setUid), []);

  const refresh = useCallback(async () => {
    setLoad({ kind: 'loading' });
    try {
      const { queue: items, now } = await fetchQueue();
      setQueue(items);
      setClockSkew(now - Date.now());
      setLoad({ kind: 'ready' });
    } catch (err) {
      setLoad(errorCode(err) === 'functions/permission-denied' ? { kind: 'denied' } : { kind: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  }, []);

  useEffect(() => {
    if (uid) void refresh();
  }, [uid, refresh]);

  async function review(clip: QueueItem, decision: Decision) {
    setBusy(clip.id);
    setNotice(null);
    try {
      const result = await decide(clip.id, decision);
      setQueue((q) => q.filter((c) => c.id !== clip.id));
      setConfirming(null);
      setNotice(
        result.status === 'already-gone'
          ? `${clip.id}: the owner had already removed it.`
          : decision === 'restore'
            ? `${clip.id}: restored to the feed.`
            : `${clip.id}: deleted permanently${result.fileDeleted ? '' : ' (no video file was removed)'}.`,
      );
    } catch (err) {
      setNotice(`Could not ${decision} ${clip.id}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(null);
    }
  }

  if (uid === undefined) return <main><p>Loading…</p></main>;
  if (uid === null) {
    return (
      <main>
        <h1>Clumsyloop moderation</h1>
        <button onClick={() => signInAdmin().catch((e) => setNotice(String(e)))}>Sign in</button>
        {notice && <p className="error">{notice}</p>}
      </main>
    );
  }

  const now = Date.now() + clockSkew;
  return (
    <main>
      <header>
        <h1>Moderation queue</h1>
        <span className="uid" title="Your user id">{uid}</span>
        <button onClick={refresh} disabled={load.kind === 'loading'}>Refresh</button>
        <button onClick={() => signOutAdmin()}>Sign out</button>
      </header>
      {notice && <p role="status">{notice}</p>}
      {load.kind === 'loading' && <p>Loading…</p>}
      {load.kind === 'denied' && (
        <p className="error" role="alert">
          This account is not on the admin list. To allow it, create an empty document <code>admins/{uid}</code> in Firestore (Firebase console), then refresh.
        </p>
      )}
      {load.kind === 'error' && <p className="error" role="alert">{load.message}</p>}
      {load.kind === 'ready' && queue.length === 0 && <p>Nothing to review.</p>}
      <ul>
        {queue.map((clip) => {
          const due = dueStatus(clip.dueAtMs, now);
          return (
            <li key={clip.id} className={`clip ${due.urgency}`} data-clip-id={clip.id}>
              <video src={clip.videoUrl} controls playsInline preload="metadata" />
              <div className="info">
                <p className={`due ${due.urgency}`}>{due.label}</p>
                {clip.caption && <p className="caption">{clip.caption}</p>}
                <p className="meta">
                  clip <code>{clip.id}</code> · owner <code>{clip.ownerId}</code> · {clip.hidden ? 'hidden' : 'still visible'}
                </p>
                <p className="meta">
                  {clip.reports.length} report{clip.reports.length === 1 ? '' : 's'}: {tallyReasons(clip.reports.map((r) => r.reason))}
                </p>
                <div className="actions">
                  <button disabled={busy === clip.id} onClick={() => review(clip, 'restore')}>Restore</button>
                  {confirming === clip.id ? (
                    <>
                      <button className="danger" disabled={busy === clip.id} onClick={() => review(clip, 'delete')}>Confirm: delete permanently</button>
                      <button onClick={() => setConfirming(null)}>Cancel</button>
                    </>
                  ) : (
                    <button className="danger" disabled={busy === clip.id} onClick={() => setConfirming(clip.id)}>Delete…</button>
                  )}
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </main>
  );
}
