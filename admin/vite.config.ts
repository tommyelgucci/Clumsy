import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * The internal review panel (task 5.3) is its own small Vite app, NOT part
 * of the main one: the main build is what Capacitor copies into the iOS
 * app, and an internal moderation tool has no business shipping inside the
 * App Store binary. Built to `dist-admin/` and served by Firebase Hosting
 * (see firebase.json). Reads the same `VITE_FIREBASE_*` variables from the
 * repo root (`envDir`), and shares `src/cloud/firebase.ts` with the app.
 */
export default defineConfig({
  root: 'admin',
  envDir: '..',
  plugins: [react()],
  server: { host: true },
  build: { outDir: '../dist-admin', emptyOutDir: true, chunkSizeWarningLimit: 650 },
});
