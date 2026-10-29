import { GoogleAuthProvider, onAuthStateChanged, signInAnonymously, signInWithPopup, signOut } from 'firebase/auth';
import { connectFunctionsEmulator, getFunctions, httpsCallable, type Functions } from 'firebase/functions';
import { useEmulators } from '../../src/cloud/config';
import { getCloud } from '../../src/cloud/firebase';

/** Mirrors `QueueItem` in functions/src/review.ts. */
export interface QueueItem {
  id: string;
  ownerId: string;
  caption: string;
  videoUrl: string;
  hidden: boolean;
  createdAtMs: number;
  reports: { reporterId: string; reason: string; createdAtMs: number }[];
  oldestReportMs: number;
  dueAtMs: number;
}

export type Decision = 'restore' | 'delete';
export interface ReviewResult {
  status: 'restored' | 'deleted' | 'already-gone';
  fileDeleted: boolean;
}

let functions: Functions | null = null;
function fns(): Functions {
  if (functions) return functions;
  functions = getFunctions(getCloud().app);
  if (useEmulators) connectFunctionsEmulator(functions, '127.0.0.1', 5001);
  return functions;
}

export function watchAdminUser(cb: (uid: string | null) => void): () => void {
  return onAuthStateChanged(getCloud().auth, (u) => cb(u?.uid ?? null));
}

/** Moderators sign in with Google (they're on a desktop browser, where the
 *  popup works; the Google provider must be enabled in the Firebase
 *  console). Against the emulators it signs in anonymously and the panel
 *  shows the uid so it can be added to `admins/`. */
export async function signInAdmin(): Promise<void> {
  const { auth } = getCloud();
  if (useEmulators) await signInAnonymously(auth);
  else await signInWithPopup(auth, new GoogleAuthProvider());
}

export const signOutAdmin = () => signOut(getCloud().auth);

export async function fetchQueue(): Promise<{ queue: QueueItem[]; now: number }> {
  const res = await httpsCallable<void, { queue: QueueItem[]; now: number }>(fns(), 'listReportedClips')();
  return res.data;
}

export async function decide(clipId: string, decision: Decision): Promise<ReviewResult> {
  const res = await httpsCallable<{ clipId: string; decision: Decision }, ReviewResult>(fns(), 'reviewClip')({ clipId, decision });
  return res.data;
}

/** The callable's error code (`permission-denied`, ...), if it is one. */
export function errorCode(err: unknown): string | undefined {
  return typeof err === 'object' && err !== null && 'code' in err ? String((err as { code: unknown }).code) : undefined;
}
