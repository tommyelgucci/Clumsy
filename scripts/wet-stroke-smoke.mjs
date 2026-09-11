import { chromium } from 'playwright';

// Visual/behavioral verification for the wet-stroke staging surface
// (task 2.10): a stroke in progress must show live on the canvas (via
// Renderer.renderDocumentFrame's wetOverlay compositing) even though the
// permanent cel isn't touched until endStroke merges into it, and a
// brand-new layer's very first stroke must preview correctly before it
// has a cel at all. Needs the dev server running (`npm run dev`).

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || '/opt/pw-browsers/chromium',
  args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 500, height: 900 } });

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

await page.goto('http://127.0.0.1:5173/', { waitUntil: 'networkidle' });
await page.waitForFunction(() => Boolean(window.__clumsyloopEngine), undefined, { timeout: 15000 });

const canvasBox = await page.locator('#drawing-canvas').boundingBox();
const docSize = await page.evaluate(() => ({ w: window.__clumsyloopEngine.doc.width, h: window.__clumsyloopEngine.doc.height }));
const toScreen = (docX, docY) => ({
  x: canvasBox.x + (docX / docSize.w) * canvasBox.width,
  y: canvasBox.y + (docY / docSize.h) * canvasBox.height,
});

// renderDocumentFrame's wetOverlay is what the canvas's own live preview
// actually uses (Engine.renderAndPresent computes it via the private
// activeStrokeOverlay() on every stamp) — reached here through bracket
// access since TS privacy is compile-time only. Reading back through
// renderer.toImageData() rather than a canvas screenshot avoids this
// project's own documented preserveDrawingBuffer:false trap (see
// checkpoint.md's task 2.2 entry): the visible <canvas> itself can't be
// read reliably in a script, but re-deriving the same composite can.
const avgAt = (docX, docY, half = 10) =>
  page.evaluate(
    ({ docX, docY, half }) => {
      const engine = window.__clumsyloopEngine;
      const overlay = engine['activeStrokeOverlay']();
      const result = engine.renderer.renderDocumentFrame(engine.doc, 0, overlay);
      const data = engine.renderer.toImageData(result);
      let r = 0, g = 0, b = 0, n = 0;
      for (let y = docY - half; y < docY + half; y++) {
        for (let x = docX - half; x < docX + half; x++) {
          const i = (y * data.width + x) * 4;
          r += data.data[i]; g += data.data[i + 1]; b += data.data[i + 2];
          n++;
        }
      }
      return { r: r / n, g: g / n, b: b / n };
    },
    { docX, docY, half },
  );

const celExists = () =>
  page.evaluate(() => {
    const engine = window.__clumsyloopEngine;
    const layer = engine.doc.layers.find((l) => l.id === engine.activeLayerId);
    return layer.cels.has(0);
  });

await page.evaluate(() => window.__clumsyloopTool.getState().setActiveBrush('fineliner'));
await page.evaluate(() => window.__clumsyloopTool.getState().setActiveColor({ r: 0, g: 0, b: 0 }));

console.log('\n— A brand-new layer with no cel yet still previews a stroke live —');
check('the active layer has no cel before the first stroke', !(await celExists()));

const start = toScreen(60, 100);
const mid = toScreen(130, 100);
await page.mouse.move(start.x, start.y);
await page.mouse.down();
await page.mouse.move(mid.x, mid.y, { steps: 8 });
// Small dwell so the brush's One Euro filter (see scripts/bucket-smoke.mjs)
// actually reaches this point before checking, without lifting the pointer.
for (let i = 0; i < 15; i++) await page.mouse.move(mid.x + (i % 2 === 0 ? 0.5 : -0.5), mid.y);

const midStroke = await avgAt(100, 100, 3);
check('the in-progress stroke is visible on the canvas before pointer-up', midStroke.r < 150, JSON.stringify(midStroke));
check('the permanent cel still does not exist mid-stroke — only the wet surface does', !(await celExists()));

await page.mouse.up();
const afterUp = await avgAt(100, 100, 3);
check('the stroke is still visible after pointer-up (now merged onto the real cel)', afterUp.r < 150, JSON.stringify(afterUp));
check('the permanent cel now exists, created by the merge at endStroke', await celExists());

console.log('\n— The eraser still bypasses the wet surface (drawn straight onto the permanent cel throughout) —');
await page.evaluate(() => window.__clumsyloopTool.getState().setActiveBrush('eraser'));
const eraseStart = toScreen(60, 100);
const eraseEnd = toScreen(130, 100);
await page.mouse.move(eraseStart.x, eraseStart.y);
await page.mouse.down();
await page.mouse.move(eraseEnd.x, eraseEnd.y, { steps: 8 });
for (let i = 0; i < 15; i++) await page.mouse.move(eraseEnd.x + (i % 2 === 0 ? 0.5 : -0.5), eraseEnd.y);
const midErase = await avgAt(100, 100, 3);
check('erasing is visible on the permanent cel mid-stroke too (no wet staging for erase)', midErase.r > 240, JSON.stringify(midErase));
await page.mouse.up();

if (errors.length > 0) {
  check('no console/page errors throughout', false, errors.join(' | '));
}

console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) failed.`}`);
await browser.close();
process.exit(failures === 0 ? 0 : 1);
