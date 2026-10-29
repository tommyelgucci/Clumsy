import { FieldValue, type DocumentData, type Firestore, type QueryDocumentSnapshot } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { InvalidReviewRequest, buildQueue, isSafeStoragePath, parseReviewRequest, type ClipRow, type QueueItem, type ReportRow } from './review.js';

/** The slice of a Storage bucket the handlers use (the real `Bucket`
 *  satisfies it; tests can too). */
export interface ReviewBucket {
  file(path: string): { delete(options?: { ignoreNotFound?: boolean }): Promise<unknown> };
}

export interface ReviewDeps {
  db: Firestore;
  bucket: ReviewBucket;
}

/** At most this many reports are read when building the queue. A backlog
 *  bigger than this means the team is days behind; the oldest (most urgent)
 *  are returned first, so the cap only ever hides the newest. */
const MAX_REPORTS = 500;

const ms = (v: { toMillis?: () => number } | undefined): number => v?.toMillis?.() ?? 0;

/** The caller must be signed in AND have an `admins/{uid}` document. That
 *  collection is unreadable and unwritable to every client (firestore.rules),
 *  so the only ways to add an admin are the Firebase console or Admin SDK
 *  code — the allowlist can't be edited from the app. */
export async function assertAdmin(db: Firestore, uid: string | undefined): Promise<string> {
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in required');
  const snap = await db.doc(`admins/${uid}`).get();
  if (!snap.exists) throw new HttpsError('permission-denied', 'This account is not on the admin list.');
  return uid;
}

function toClip(snap: QueryDocumentSnapshot<DocumentData> | FirebaseFirestore.DocumentSnapshot<DocumentData>): ClipRow {
  const d = snap.data() ?? {};
  return {
    id: snap.id,
    ownerId: String(d.ownerId ?? ''),
    caption: typeof d.caption === 'string' ? d.caption : '',
    videoUrl: typeof d.videoUrl === 'string' ? d.videoUrl : '',
    hidden: d.hidden === true,
    createdAtMs: ms(d.createdAt),
  };
}

/** Reported clips awaiting a decision, most urgent first. */
export async function listReportedClipsHandler({ db }: ReviewDeps, uid: string | undefined): Promise<{ queue: QueueItem[]; now: number }> {
  await assertAdmin(db, uid);
  const reportSnap = await db.collection('reports').orderBy('createdAt', 'asc').limit(MAX_REPORTS).get();
  const reports: ReportRow[] = reportSnap.docs
    .map((d) => ({ clipId: d.get('clipId'), reporterId: d.get('reporterId'), reason: d.get('reason'), createdAtMs: ms(d.get('createdAt')) }))
    .filter((r): r is ReportRow => typeof r.clipId === 'string' && r.clipId.length > 0);

  const clipIds = [...new Set(reports.map((r) => r.clipId))];
  const clips = new Map<string, ClipRow>();
  if (clipIds.length > 0) {
    const snaps = await db.getAll(...clipIds.map((id) => db.doc(`clips/${id}`)));
    for (const s of snaps) if (s.exists) clips.set(s.id, toClip(s));
  }
  return { queue: buildQueue(reports, clips), now: Date.now() };
}

/** Deletes in batches under Firestore's 500-write limit. */
async function deleteAll(db: Firestore, refs: FirebaseFirestore.DocumentReference[]): Promise<void> {
  for (let i = 0; i < refs.length; i += 400) {
    const batch = db.batch();
    for (const ref of refs.slice(i, i + 400)) batch.delete(ref);
    await batch.commit();
  }
}

export type ReviewResult = { status: 'restored' | 'deleted' | 'already-gone'; fileDeleted: boolean };

/**
 * The moderator's decision on a reported clip.
 *
 * - `restore`: the clip is shown again (`hidden: false`) and its reports are
 *   cleared, so it isn't re-queued and the reporters could report it again
 *   if it's still a problem.
 * - `delete`: the video file goes first, then the clip document and its
 *   reports. File first on purpose: if the file delete fails the documents
 *   are still there to retry from, instead of leaving an orphaned file
 *   nothing points at any more.
 *
 * Every decision is recorded in `moderationLog` (who, what, which reports) —
 * the trail for showing Apple the 24-hour process actually runs.
 */
export async function reviewClipHandler({ db, bucket }: ReviewDeps, uid: string | undefined, data: unknown): Promise<ReviewResult> {
  const adminUid = await assertAdmin(db, uid);
  let request;
  try {
    request = parseReviewRequest(data);
  } catch (err) {
    if (err instanceof InvalidReviewRequest) throw new HttpsError('invalid-argument', err.message);
    throw err;
  }
  const { clipId, decision } = request;

  const clipRef = db.doc(`clips/${clipId}`);
  const [clipSnap, reportSnap] = await Promise.all([clipRef.get(), db.collection('reports').where('clipId', '==', clipId).get()]);
  const reportRefs = reportSnap.docs.map((d) => d.ref);
  const log = (extra: Record<string, unknown>) =>
    db.collection('moderationLog').add({
      clipId,
      decision,
      adminUid,
      reportCount: reportSnap.size,
      reasons: reportSnap.docs.map((d) => d.get('reason')),
      at: FieldValue.serverTimestamp(),
      ...extra,
    });

  if (!clipSnap.exists) {
    // The owner already removed it. Its reports are stale: clear them so the
    // queue doesn't keep listing a clip that isn't there.
    await deleteAll(db, reportRefs);
    await log({ outcome: 'already-gone' });
    return { status: 'already-gone', fileDeleted: false };
  }

  const ownerId = String(clipSnap.get('ownerId') ?? '');
  if (decision === 'restore') {
    await clipRef.set({ hidden: false }, { merge: true });
    await deleteAll(db, reportRefs);
    await log({ ownerId, outcome: 'restored' });
    return { status: 'restored', fileDeleted: false };
  }

  const storagePath = clipSnap.get('storagePath');
  let fileDeleted = false;
  if (isSafeStoragePath(storagePath, ownerId, clipId)) {
    try {
      await bucket.file(storagePath).delete({ ignoreNotFound: true });
      fileDeleted = true;
    } catch (err) {
      throw new HttpsError('internal', `Could not delete the video file: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  await deleteAll(db, [clipRef, ...reportRefs]);
  await log({ ownerId, outcome: 'deleted', fileDeleted });
  return { status: 'deleted', fileDeleted };
}
