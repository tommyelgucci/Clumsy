import { FirebaseError } from 'firebase/app';
import {
  collection,
  deleteDoc,
  doc,
  getDocs,
  limit,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  startAfter,
  where,
  type DocumentData,
  type QueryDocumentSnapshot,
} from 'firebase/firestore';
import { deleteObject, getDownloadURL, ref, uploadBytesResumable } from 'firebase/storage';
import {
  buildClipFields,
  clipStoragePath,
  filterBlocked,
  reportDocId,
  type ClipRecord,
  type ReportReason,
} from './clipModel';
import { getCloud } from './firebase';

/** The signed-in uid, or a refusal the UI turns into a sign-in prompt. */
function requireUid(): string {
  const uid = getCloud().auth.currentUser?.uid;
  if (!uid) throw new Error('Sign in first.');
  return uid;
}

export interface PublishMeta {
  caption: string;
  width: number;
  height: number;
  fps: number;
  frames: number;
}

/**
 * Publishes an exported MP4 (task 4.1): uploads it to the caller's own
 * Storage prefix, then creates the `clips` document pointing at it. The
 * document is written last so a failed upload never leaves a feed entry
 * with no video; if the document write fails after the upload, the orphaned
 * file is removed on a best-effort basis.
 */
export async function publishClip(blob: Blob, meta: PublishMeta, onProgress?: (fraction: number) => void): Promise<string> {
  const { db, storage } = getCloud();
  const ownerId = requireUid();
  const clipRef = doc(collection(db, 'clips'));
  const fileRef = ref(storage, clipStoragePath(ownerId, clipRef.id));

  const task = uploadBytesResumable(fileRef, blob, { contentType: 'video/mp4' });
  await new Promise<void>((resolve, reject) => {
    task.on(
      'state_changed',
      (s) => onProgress?.(s.totalBytes > 0 ? s.bytesTransferred / s.totalBytes : 0),
      reject,
      () => resolve(),
    );
  });
  try {
    const videoUrl = await getDownloadURL(fileRef);
    await setDoc(clipRef, { ...buildClipFields({ ownerId, clipId: clipRef.id, videoUrl, ...meta }), createdAt: serverTimestamp() });
  } catch (err) {
    await deleteObject(fileRef).catch(() => {});
    throw err;
  }
  return clipRef.id;
}

function toClip(snap: QueryDocumentSnapshot<DocumentData>): ClipRecord {
  const d = snap.data();
  return {
    id: snap.id,
    ownerId: d.ownerId,
    videoUrl: d.videoUrl,
    storagePath: d.storagePath,
    caption: d.caption ?? '',
    createdAtMs: d.createdAt?.toMillis?.() ?? Date.now(),
    width: d.width,
    height: d.height,
    fps: d.fps,
    frames: d.frames,
  };
}

export interface FeedPage {
  clips: ClipRecord[];
  /** Pass back to `fetchFeedPage` for the next page. */
  cursor: QueryDocumentSnapshot<DocumentData> | null;
  done: boolean;
}

/**
 * One page of the feed (task 4.2): newest first, no ranking. Only
 * non-hidden clips — the `hidden == false` filter is also what lets
 * `firestore.rules` prove a list query is allowed (it needs a composite
 * index with `createdAt`; see `firestore.indexes.json`). Blocked authors are
 * filtered out client-side, so a page can come back short; this keeps
 * pulling until it has `pageSize` clips or the feed runs out.
 */
export async function fetchFeedPage(cursor: FeedPage['cursor'] = null, pageSize = 12): Promise<FeedPage> {
  const { db } = getCloud();
  const blocked = await fetchBlockedIds();
  const clips: ClipRecord[] = [];
  let last = cursor;
  let done = false;
  while (clips.length < pageSize && !done) {
    const snap = await getDocs(
      query(collection(db, 'clips'), where('hidden', '==', false), orderBy('createdAt', 'desc'), ...(last ? [startAfter(last)] : []), limit(pageSize)),
    );
    if (snap.empty) {
      done = true;
      break;
    }
    last = snap.docs[snap.docs.length - 1];
    done = snap.size < pageSize;
    clips.push(...filterBlocked(snap.docs.map(toClip), blocked));
  }
  return { clips, cursor: last, done };
}

/** The owner's own "take this down" (the rules allow it): removes the
 *  document, then the video file. */
export async function deleteOwnClip(clip: ClipRecord): Promise<void> {
  const { db, storage } = getCloud();
  requireUid();
  await deleteDoc(doc(db, 'clips', clip.id));
  await deleteObject(ref(storage, clip.storagePath)).catch((err) => {
    if (!(err instanceof FirebaseError && err.code === 'storage/object-not-found')) throw err;
  });
}

/** Files a report (task 5.1). Returns `'duplicate'` when this person already
 *  reported this clip: the report id is per (clip, reporter) and the rules
 *  refuse updates, so for a signed-in caller sending a well-formed report a
 *  permission-denied can only mean that. */
export async function reportClip(clipId: string, reason: ReportReason): Promise<'filed' | 'duplicate'> {
  const { db } = getCloud();
  const reporterId = requireUid();
  try {
    await setDoc(doc(db, 'reports', reportDocId(clipId, reporterId)), { reporterId, clipId, reason, createdAt: serverTimestamp() });
    return 'filed';
  } catch (err) {
    if (err instanceof FirebaseError && err.code === 'permission-denied') return 'duplicate';
    throw err;
  }
}

/** Authors this user has blocked, as uids. Empty when signed out. */
export async function fetchBlockedIds(): Promise<Set<string>> {
  const { db, auth } = getCloud();
  const uid = auth.currentUser?.uid;
  if (!uid) return new Set();
  const snap = await getDocs(collection(db, 'users', uid, 'blocks'));
  return new Set(snap.docs.map((d) => d.id));
}

export async function blockUser(blockedId: string): Promise<void> {
  const uid = requireUid();
  await setDoc(doc(getCloud().db, 'users', uid, 'blocks', blockedId), { createdAt: serverTimestamp() });
}

export async function unblockUser(blockedId: string): Promise<void> {
  const uid = requireUid();
  await deleteDoc(doc(getCloud().db, 'users', uid, 'blocks', blockedId));
}

/** Whether `uid` has an active subscription, now and as it changes (task
 *  3.5). Read-only: only the validation Cloud Function ever writes this. */
export function watchEntitlement(uid: string, cb: (active: boolean) => void): () => void {
  return onSnapshot(
    doc(getCloud().db, 'entitlements', uid),
    (snap) => cb(snap.data()?.active === true),
    () => cb(false),
  );
}
