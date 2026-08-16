import { createRoot } from 'react-dom/client';
import { App } from './ui/App';

// No StrictMode: the WebGL2 engine (phase 2) mounts a single context onto
// the canvas, and StrictMode's double-mount would create two — same
// reasoning as Trace.
createRoot(document.getElementById('root')!).render(<App />);
