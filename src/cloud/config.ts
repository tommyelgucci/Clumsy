/**
 * Whether cloud features are configured at all. Kept apart from `firebase.ts`
 * on purpose: this file imports nothing from Firebase, so the editor can ask
 * "is there a cloud?" without pulling the whole SDK (~600 kB) into the main
 * bundle. Everything that does use Firebase is loaded lazily behind this.
 */
export const useEmulators = import.meta.env.VITE_USE_FIREBASE_EMULATORS === 'true';

const env = import.meta.env;
export const realConfig = {
  apiKey: env.VITE_FIREBASE_API_KEY,
  authDomain: env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: env.VITE_FIREBASE_STORAGE_BUCKET,
  appId: env.VITE_FIREBASE_APP_ID,
};

export const cloudAvailable = useEmulators || Object.values(realConfig).every(Boolean);
