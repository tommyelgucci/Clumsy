import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { cloudAvailable } from '../../src/cloud/config';
import { Panel } from './Panel';
import './admin.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {cloudAvailable ? (
      <Panel />
    ) : (
      <main>
        <h1>Clumsyloop moderation</h1>
        <p className="error">Firebase is not configured. Set the VITE_FIREBASE_* variables (see .env.example).</p>
      </main>
    )}
  </StrictMode>,
);
