import { chromium } from 'playwright';

// Visual/behavioral verification for undo/redo (task: wire core/history.ts
// into gl/engine.ts): real pointer-drawn strokes, a real bucket fill, and
// the Clear button, each undone and redone through the actual UI —
// buttons and keyboard shortcuts alike — not just by calling
// engine.undo()/redo() directly. Needs the dev server running (`npm run dev`).

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

/** See scripts/bucket-smoke.mjs's dragStroke for why the dwell at the end
 *  matters (the ported One Euro smoothing filter's real steady-state lag
 *  behind constant-velocity motion) — not needed as precisely here since
 *  these checks don't depend on exact endpoints, but kept for reliability. */
const dragStroke = async (points) => {
  const first = toScreen(...points[0]);
  await page.mouse.move(first.x, first.y);
  await page.mouse.down();
  for (const p of points.slice(1)) {
    const s = toScreen(...p);
    await page.mouse.move(s.x, s.y, { steps: 8 });
  }
  const last = toScreen(...points[points.length - 1]);
  for (let i = 0; i < 15; i++) {
    await page.mouse.move(last.x + (i % 2 === 0 ? 0.5 : -0.5), last.y);
  }
  await page.mouse.up();
};

const avgAt = (docX, docY, half = 10) =>
  page.evaluate(
    ({ docX, docY, half }) => {
      const engine = window.__clumsyloopEngine;
      const result = engine.renderer.renderDocumentFrame(engine.doc, 0);
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

const historyState = () => page.evaluate(() => ({ canUndo: window.__clumsyloopEngine.history.canUndo, canRedo: window.__clumsyloopEngine.history.canRedo }));

/** Waits for the active cel's surface.version to bump — same reasoning
 *  as bucket-smoke.mjs: floodFill is an async Worker round trip. */
const waitForCelChange = (before) =>
  page.waitForFunction(
    (before) => {
      const engine = window.__clumsyloopEngine;
      const layer = engine.doc.layers.find((l) => l.id === engine.activeLayerId);
      const cel = layer.cels.get(0);
      return Boolean(cel) && cel.surface.version > before;
    },
    before,
    { timeout: 10000 },
  );
const celVersion = () =>
  page.evaluate(() => {
    const engine = window.__clumsyloopEngine;
    const layer = engine.doc.layers.find((l) => l.id === engine.activeLayerId);
    const cel = layer.cels.get(0);
    return cel ? cel.surface.version : -1;
  });

await page.evaluate(() => window.__clumsyloopTool.getState().setActiveBrush('marker'));
await page.evaluate(() => window.__clumsyloopTool.getState().setActiveColor({ r: 0, g: 0, b: 0 }));

console.log('\n— A stroke can be undone (button) and redone (keyboard) —');
let hist = await historyState();
check('nothing to undo before any drawing', !hist.canUndo, JSON.stringify(hist));
await dragStroke([[60, 100], [200, 100]]);
// half=3 (not the 15 used for blank-paper checks below): the 'marker'
// brush preset is a chisel tip (aspect: 0.35), so its actual cross-stroke
// width is size(28) * aspect ≈ 9.8px, not the full 28px diameter — a wide
// averaging box washes the thin line out into a false negative.
const afterStroke = await avgAt(130, 100, 3);
check('the stroke is visible', afterStroke.r < 150, JSON.stringify(afterStroke));
hist = await historyState();
check('canUndo is true after drawing', hist.canUndo && !hist.canRedo, JSON.stringify(hist));

await page.getByRole('button', { name: /^Undo/ }).click();
const afterUndo = await avgAt(130, 100, 15);
check('undo (button) removes the stroke', afterUndo.r > 240, JSON.stringify(afterUndo));
hist = await historyState();
check('canRedo is true after undoing', !hist.canUndo && hist.canRedo, JSON.stringify(hist));

await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Shift+z' : 'Control+Shift+z');
await page.waitForTimeout(100);
const afterRedo = await avgAt(130, 100, 3);
check('redo (keyboard, Shift+Ctrl/Cmd+Z) brings the stroke back', afterRedo.r < 150, JSON.stringify(afterRedo));

console.log('\n— Two strokes undo independently, in the right order —');
await dragStroke([[60, 200], [200, 200]]);
const bothStrokes = await avgAt(130, 200, 3);
check('the second stroke is visible', bothStrokes.r < 150, JSON.stringify(bothStrokes));
await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
await page.waitForTimeout(100);
const secondUndone = await avgAt(130, 200, 15);
check('undoing once removes only the second stroke', secondUndone.r > 240, JSON.stringify(secondUndone));
const firstStillThere = await avgAt(130, 100, 3);
check('the first stroke is still there', firstStillThere.r < 150, JSON.stringify(firstStillThere));
await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
await page.waitForTimeout(100);
const bothUndone = await avgAt(130, 100, 15);
check('undoing again removes the first stroke too', bothUndone.r > 240, JSON.stringify(bothUndone));
hist = await historyState();
check('nothing left to undo', !hist.canUndo && hist.canRedo, JSON.stringify(hist));

console.log('\n— A new stroke after undoing invalidates redo —');
await dragStroke([[60, 300], [200, 300]]);
hist = await historyState();
check('drawing after undo clears the redo stack', hist.canUndo && !hist.canRedo, JSON.stringify(hist));

console.log('\n— Clear can be undone —');
await page.getByRole('button', { name: 'Clear' }).click();
const afterClear = await avgAt(130, 300, 15);
check('Clear wipes the layer', afterClear.r > 240, JSON.stringify(afterClear));
await page.getByRole('button', { name: /^Undo/ }).click();
const afterClearUndo = await avgAt(130, 300, 3);
check('undoing Clear restores the drawing', afterClearUndo.r < 150, JSON.stringify(afterClearUndo));

console.log('\n— A bucket fill can be undone and redone —');
await page.evaluate(() => window.__clumsyloopEngine.clearActiveLayer());
await page.evaluate(() => window.__clumsyloopTool.getState().setActiveBrush('fineliner'));
await dragStroke([[80, 450], [280, 450]]);
await dragStroke([[280, 450], [280, 550]]);
await dragStroke([[280, 550], [80, 550]]);
await dragStroke([[80, 550], [80, 450]]);
await page.evaluate(() => window.__clumsyloopTool.getState().setMode('bucket'));
await page.evaluate(() => window.__clumsyloopTool.getState().setActiveColor({ r: 0.1, g: 0.6, b: 0.2 }));
let before = await celVersion();
const fillPoint = toScreen(180, 500);
await page.mouse.click(fillPoint.x, fillPoint.y);
await waitForCelChange(before);
const filled = await avgAt(180, 500, 15);
check('the bucket fill landed', filled.g > 150 && filled.r < 150, JSON.stringify(filled));

before = await celVersion();
await page.getByRole('button', { name: /^Undo/ }).click();
await waitForCelChange(before).catch(() => {}); // writeRect bumps version synchronously; guard in case it already had
await page.waitForTimeout(100);
const fillUndone = await avgAt(180, 500, 15);
check('undoing the fill removes the color, leaves the outline area blank', fillUndone.r > 240 && fillUndone.g > 240, JSON.stringify(fillUndone));

await page.getByRole('button', { name: /^Redo/ }).click();
await page.waitForTimeout(100);
const fillRedone = await avgAt(180, 500, 15);
check('redoing the fill brings the color back', fillRedone.g > 150 && fillRedone.r < 150, JSON.stringify(fillRedone));

if (errors.length > 0) {
  check('no console/page errors throughout', false, errors.join(' | '));
}

console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) failed.`}`);
await browser.close();
process.exit(failures === 0 ? 0 : 1);
