import { chromium } from 'playwright';

// Visual/behavioral verification for task 2.5 (local project
// persistence): drives the PersistenceHarness (window.__clumsyloopPersistence)
// through a save, then a full page reload — the closest proxy this
// environment has for "force-quit and relaunch" (no physical device, see
// CLAUDE.md) — and confirms the reloaded project is pixel-identical.
// Needs the dev server running (`npm run dev`), same convention as
// renderer-smoke.mjs.

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || '/opt/pw-browsers/chromium',
  args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 800, height: 900 } });

const errors = [];
page.on('console', (m) => {
  if (m.type() === 'error' && !m.location().url.includes('favicon.ico')) errors.push(m.text());
});
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

let failures = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failures++;
};

// Start from a clean slate. This Chromium install keeps a persistent
// profile across separate `chromium.launch()` calls (confirmed: a
// brand-new browser/context still had localStorage from a previous run
// of this same script), so a plain `localStorage.removeItem` isn't
// enough — this clears storage and drops the IndexedDB database outright.
//
// Must wait for the FIRST load's own harness run to fully settle before
// clearing anything: `networkidle` resolves long before the harness's
// async IndexedDB save does, and clearing mid-save loses the race — the
// in-flight save's own `localStorage.setItem('saved')` lands right after
// the clear and undoes it. Confirmed by tracing localStorage through the
// sequence directly; not a hypothetical.
await page.goto('http://127.0.0.1:5173/', { waitUntil: 'networkidle' });
await page.waitForFunction(() => window.__clumsyloopPersistence !== undefined, undefined, { timeout: 15000 });
await page.evaluate(
  () =>
    new Promise((resolve, reject) => {
      window.localStorage.clear();
      const req = window.indexedDB.deleteDatabase('clumsyloop');
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
      req.onblocked = () => resolve(); // no other tab has it open in this harness
    }),
);
await page.reload({ waitUntil: 'networkidle' });
await page.waitForFunction(() => window.__clumsyloopPersistence?.phase === 'saved', undefined, { timeout: 15000 });

const summarize = () =>
  page.evaluate(() => {
    const { doc, renderer, frame0, frame6 } = window.__clumsyloopPersistence;
    const avg = (surface, rect) => {
      const data = renderer.toImageData(surface);
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let y = rect.y; y < rect.y2; y++) {
        for (let x = rect.x; x < rect.x2; x++) {
          const i = (y * data.width + x) * 4;
          r += data.data[i]; g += data.data[i + 1]; b += data.data[i + 2]; a += data.data[i + 3];
          n++;
        }
      }
      return { r: r / n, g: g / n, b: b / n, a: a / n };
    };
    const corner = { x: 4, y: 4, x2: 20, y2: 20 };
    const strokeArea = { x: 90, y: 145, x2: 110, y2: 155 };
    return {
      docId: doc.id,
      layerCount: doc.layers.length,
      layerIds: doc.layers.map((l) => l.id),
      celCounts: doc.layers.map((l) => l.cels.size),
      frame0Corner: avg(frame0, corner),
      frame6Corner: avg(frame6, corner),
      frame0Stroke: avg(frame0, strokeArea),
    };
  });

const before = await summarize();
check('frame 0 shows the first camera take (blue)', before.frame0Corner.r < 100 && before.frame0Corner.b > 150, JSON.stringify(before.frame0Corner));
check('frame 6 shows the second camera take (pink)', before.frame6Corner.r > 150 && before.frame6Corner.g < 100, JSON.stringify(before.frame6Corner));
check('the ink stroke is visible on frame 0 (dark)', before.frame0Stroke.r < 140, JSON.stringify(before.frame0Stroke));

console.log('\n— Reloading the page (proxy for a force-quit + relaunch) —');
await page.reload({ waitUntil: 'networkidle' });
await page.waitForFunction(() => window.__clumsyloopPersistence?.phase === 'loaded', undefined, { timeout: 15000 });

if (errors.length > 0) {
  check('no console/page errors across save + reload', false, errors.join(' | '));
}

// Solid, fully-opaque areas (the corners) must be bit-exact: alpha=255
// makes premultiply/unpremultiply a no-op, no rounding possible either
// direction. The stroke area is genuinely partial-alpha (antialiased
// brush edges) and goes through an extra unpremultiply (save) +
// premultiply (load) round trip that a plain corner pixel doesn't — a
// ±1-per-channel drift there is inherent 8-bit rounding, not a
// correctness bug, so that one comparison alone gets a small tolerance.
const closeEnough = (a, b, tol) => Math.abs(a.r - b.r) <= tol && Math.abs(a.g - b.g) <= tol && Math.abs(a.b - b.b) <= tol && Math.abs(a.a - b.a) <= tol;

const after = await summarize();
check('document id survives the reload', after.docId === before.docId, `${before.docId} -> ${after.docId}`);
check('layer count survives the reload', after.layerCount === before.layerCount, `${before.layerCount} -> ${after.layerCount}`);
check('layer ids survive in the same order', JSON.stringify(after.layerIds) === JSON.stringify(before.layerIds));
check('cel counts per layer survive', JSON.stringify(after.celCounts) === JSON.stringify(before.celCounts), `${JSON.stringify(before.celCounts)} -> ${JSON.stringify(after.celCounts)}`);
check(
  'frame 0\'s solid photo area composites bit-identically after reload',
  JSON.stringify(after.frame0Corner) === JSON.stringify(before.frame0Corner),
  `before ${JSON.stringify(before.frame0Corner)} -> after ${JSON.stringify(after.frame0Corner)}`,
);
check(
  'frame 0\'s antialiased stroke area matches within 8-bit rounding after reload',
  closeEnough(after.frame0Stroke, before.frame0Stroke, 2),
  `before ${JSON.stringify(before.frame0Stroke)} -> after ${JSON.stringify(after.frame0Stroke)}`,
);
check(
  'frame 6 composites bit-identically after reload (second camera take)',
  JSON.stringify(after.frame6Corner) === JSON.stringify(before.frame6Corner),
  `before ${JSON.stringify(before.frame6Corner)} -> after ${JSON.stringify(after.frame6Corner)}`,
);

console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) failed.`}`);
await browser.close();
process.exit(failures === 0 ? 0 : 1);
