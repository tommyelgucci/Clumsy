import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  // GitHub Pages serves this repo at /Clumsy/, not the root — Capacitor's
  // own build (npm run build, no env var) needs base '/' since it's
  // served from the webview's root. Only the Pages workflow sets this.
  base: process.env.GITHUB_PAGES ? '/Clumsy/' : '/',
  plugins: [react()],
  server: {
    host: true,
  },
});
