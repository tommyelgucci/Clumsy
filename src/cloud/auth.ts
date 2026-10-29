import { onAuthStateChanged, signInAnonymously, signOut } from 'firebase/auth';
import { useEmulators } from './config';
import { getCloud } from './firebase';

export interface CloudUser {
  uid: string;
}

/** Calls `cb` with the signed-in user, or null, now and on every change. */
export function watchUser(cb: (user: CloudUser | null) => void): () => void {
  return onAuthStateChanged(getCloud().auth, (u) => cb(u ? { uid: u.uid } : null));
}

/**
 * Starts sign-in. Sign in with Apple is the real method (CLAUDE.md), but it
 * needs the native plugin, an Apple Developer capability, and a Firebase
 * project — all task 3.1, none of which can be done or verified without a
 * device — so outside the emulators this refuses plainly instead of pretending.
 * Against the emulators it signs in anonymously, which is enough to exercise
 * everything that only needs *a* uid (publish, report, block).
 */
export async function signIn(): Promise<void> {
  if (useEmulators) {
    await signInAnonymously(getCloud().auth);
    return;
  }
  throw new Error('Sign in with Apple is not set up yet.');
}

export async function signOutUser(): Promise<void> {
  await signOut(getCloud().auth);
}
