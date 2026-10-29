import { initializeApp, type FirebaseApp } from 'firebase/app';
import { connectAuthEmulator, getAuth, type Auth } from 'firebase/auth';
import { connectFirestoreEmulator, getFirestore, type Firestore } from 'firebase/firestore';
import { connectStorageEmulator, getStorage, type FirebaseStorage } from 'firebase/storage';
import { cloudAvailable, realConfig, useEmulators } from './config';

/**
 * Firebase wiring. The app is local-first: everything under `src/cloud/` is
 * optional, and `cloudAvailable` (`config.ts`, which doesn't import Firebase)
 * is what the UI checks before showing any cloud affordance at all. Two ways to turn it on:
 *
 * - **Real project:** set `VITE_FIREBASE_API_KEY`, `VITE_FIREBASE_AUTH_DOMAIN`,
 *   `VITE_FIREBASE_PROJECT_ID`, `VITE_FIREBASE_STORAGE_BUCKET`, and
 *   `VITE_FIREBASE_APP_ID` (from the Firebase console — task 3.1).
 * - **Local emulators:** `VITE_USE_FIREBASE_EMULATORS=true` points everything
 *   at the Auth/Firestore/Storage emulators on 127.0.0.1 with the
 *   `demo-clumsyloop` project (see `.firebaserc`). Never touches real GCP.
 */

export interface Cloud {
  app: FirebaseApp;
  auth: Auth;
  db: Firestore;
  storage: FirebaseStorage;
}

let cloud: Cloud | null = null;

/** The Firebase services, created on first use. Throws if the app has no
 *  Firebase configuration — callers gate on `cloudAvailable` first. */
export function getCloud(): Cloud {
  if (cloud) return cloud;
  if (!cloudAvailable) throw new Error('Cloud features are not configured.');
  const app = initializeApp(
    useEmulators
      ? { apiKey: 'demo', authDomain: 'demo-clumsyloop.firebaseapp.com', projectId: 'demo-clumsyloop', storageBucket: 'demo-clumsyloop.appspot.com', appId: 'demo' }
      : (realConfig as Record<string, string>),
  );
  const auth = getAuth(app);
  const db = getFirestore(app);
  const storage = getStorage(app);
  if (useEmulators) {
    connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
    connectFirestoreEmulator(db, '127.0.0.1', 8080);
    connectStorageEmulator(storage, '127.0.0.1', 9199);
  }
  cloud = { app, auth, db, storage };
  return cloud;
}
