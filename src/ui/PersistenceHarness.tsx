import { useEffect, useRef, useState } from 'react';
import { DEFAULT_BRUSHES, StrokeBuilder } from '../core/brush';
import { newDocument, newLayer, type ClumsyloopDocument } from '../core/document';
import { mat3FromTRS } from '../core/math';
import type { InputSample } from '../core/types';
import { captureProject, restoreProject } from '../gl/projectIO';
import { Renderer, type Surface } from '../gl/renderer';
import { deleteProject, loadProject, saveProject } from '../state/projectStore';

const PROJECT_ID = 'harness-project';
const PHASE_KEY = 'clumsyloop:persistenceHarnessPhase';

function solidCanvas(width: number, height: number, color: string): HTMLCanvasElement {
  const c = window.document.createElement('canvas');
  c.width = width;
  c.height = height;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, width, height);
  return c;
}

/** `renderDocumentFrame` returns one of the renderer's own scratch
 *  buffers (see its doc comment in renderer.ts) — rendering frame 0 then
 *  frame 6 without copying each result out would have the second call
 *  silently overwrite the first, since both frames' clip-group count
 *  gives the ping-pong pool the same parity. Copied into dedicated
 *  surfaces here so both stay independently readable afterward. */
function renderBothFrames(renderer: Renderer, doc: ClumsyloopDocument): { frame0: Surface; frame6: Surface } {
  const frame0 = renderer.createSurface('frame0');
  renderer.copy(frame0, renderer.renderDocumentFrame(doc, 0), 1);
  const frame6 = renderer.createSurface('frame6');
  renderer.copy(frame6, renderer.renderDocumentFrame(doc, 6), 1);
  return { frame0, frame6 };
}

/**
 * Manual + scripted test harness for task 2.5 (local project
 * persistence). "Closed mid capture session and reopened" (the
 * acceptance criteria) can't be simulated with a physical force-quit
 * from this environment (no device — see CLAUDE.md), so this uses the
 * closest real equivalent: a full page reload. IndexedDB and
 * `localStorage` both survive that the same way they survive an iOS
 * force-quit + relaunch (same-origin persistent storage, not
 * session/memory state) — a fresh JS runtime and a fresh WebGL context
 * come back and have to find everything on disk, same as a cold app
 * launch would.
 *
 * Phase is tracked in `localStorage` (survives the reload the same way
 * the saved project does): absent — or explicitly cleared, see
 * `scripts/persistence-smoke.mjs` — means "build a project and save it";
 * present means "load it back and prove it matches."
 */
export function PersistenceHarness() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [status, setStatus] = useState('Working…');

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let cancelled = false;

    async function run() {
      const phase = window.localStorage.getItem(PHASE_KEY);
      const renderer = new Renderer(canvas!);

      if (phase !== 'saved') {
        await deleteProject(PROJECT_ID); // idempotent re-runs, no leftover from a prior run
        const doc = newDocument(200, 300, 12, 12);
        doc.id = PROJECT_ID;
        renderer.setDocumentSize(doc.width, doc.height);

        const camera = newLayer('Camera', true, 'camera');
        const takeA = renderer.createSurface('take-a');
        renderer.uploadImage(takeA, solidCanvas(doc.width, doc.height, '#3b6fd6'));
        const takeB = renderer.createSurface('take-b');
        renderer.uploadImage(takeB, solidCanvas(doc.width, doc.height, '#d63b6f'));
        camera.cels.set(0, { id: 'take-a', surface: takeA, label: 'Take 1' });
        camera.cels.set(6, { id: 'take-b', surface: takeB });
        doc.layers.push(camera);

        const ink = newLayer('Ink', true, 'draw');
        const inkSurface = renderer.createSurface('ink-cel');
        const pencil = DEFAULT_BRUSHES.find((b) => b.id === 'pencil')!;
        const builder = new StrokeBuilder(pencil);
        const sample = (x: number, y: number, t: number): InputSample => ({ x, y, pressure: 1, altitude: 0, azimuth: 0, time: t });
        const stamps = [...builder.begin(sample(40, 150, 0)), ...builder.push(sample(160, 150, 60)), ...builder.end()];
        renderer.drawStamps(inkSurface, stamps, { r: 0.1, g: 0.1, b: 0.1 });
        ink.cels.set(0, { id: 'ink-cel', surface: inkSurface });
        doc.layers.push(ink);

        const captured = captureProject(renderer, doc);
        await saveProject(PROJECT_ID, captured);
        window.localStorage.setItem(PHASE_KEY, 'saved');

        if (cancelled) return;
        const savedFrames = renderBothFrames(renderer, doc);
        renderer.present(savedFrames.frame0, mat3FromTRS(0, 0, 0, canvas!.width, canvas!.height), doc.paper, doc.paperAlpha, 16);
        (window as unknown as { __clumsyloopPersistence: unknown }).__clumsyloopPersistence = {
          phase: 'saved',
          renderer,
          doc,
          ...savedFrames,
        };
        setStatus('Saved — reload the page to verify it loads back identically.');
        return;
      }

      const project = await loadProject(PROJECT_ID);
      if (!project) {
        setStatus('No saved project found — reload without a prior save first.');
        return;
      }
      renderer.setDocumentSize(project.meta.width, project.meta.height);
      const doc = restoreProject(renderer, project);

      if (cancelled) return;
      const loadedFrames = renderBothFrames(renderer, doc);
      renderer.present(loadedFrames.frame0, mat3FromTRS(0, 0, 0, canvas!.width, canvas!.height), doc.paper, doc.paperAlpha, 16);
      (window as unknown as { __clumsyloopPersistence: unknown }).__clumsyloopPersistence = {
        phase: 'loaded',
        renderer,
        doc,
        ...loadedFrames,
      };
      setStatus('Loaded from IndexedDB after reload.');
    }

    run();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div>
      <h2>Persistence smoke test (task 2.5)</h2>
      <canvas ref={canvasRef} width={200} height={300} style={{ border: '1px solid #444', background: '#222' }} />
      <p>{status}</p>
    </div>
  );
}
