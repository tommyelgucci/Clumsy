import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
  },
  build: {
    // The Firebase SDK is its own ~570 kB chunk, loaded only when the app
    // has Firebase configuration (see src/cloud/config.ts); the main bundle
    // stays ~400 kB. Silences the warning for that known, lazy chunk.
    chunkSizeWarningLimit: 650,
  },
});
