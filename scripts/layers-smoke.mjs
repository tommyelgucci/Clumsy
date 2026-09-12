import { chromium } from 'playwright';

// Visual/behavioral verification for the layers panel (task 2.9): add,
// delete, reorder, rename, hide/show, and lock/unlock layers through the
// actual UI, and confirm the active layer (the one strokes/fills write
// into) tracks panel selection. Needs the dev server running (`npm run dev`).

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || '/opt/pw-browsers/chromium',
  args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 500, height: 1100 } });

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

// The Layers panel is a closed-by-default floating overlay (task 2.13) —
// open it once here so the rest of this script can find its contents
// (Add layer, per-row rename/hide/lock/reorder/delete) in the DOM.
await page.getByRole('button', { name: 'Layers' }).click();

const canvasBox = await page.locator('#drawing-canvas').boundingBox();
const docSize = await page.evaluate(() => ({ w: window.__clumsyloopEngine.doc.width, h: window.__clumsyloopEngine.doc.height }));
// The canvas is `object-fit: contain` (task 2.12's responsive layout), so
// its element box and its actually-rendered content don't necessarily
// share an aspect ratio on every viewport — the layout can letterbox it
// on a short/wide one. This recovers the real content rect, mirroring
// DrawingCanvas.tsx's own toSample() inverse transform; a naive
// canvasBox.width/height scale only ever worked by coincidence before
// the canvas could actually letterbox.
const scale = Math.min(canvasBox.width / docSize.w, canvasBox.height / docSize.h);
const contentOffsetX = canvasBox.x + (canvasBox.width - docSize.w * scale) / 2;
const contentOffsetY = canvasBox.y + (canvasBox.height - docSize.h * scale) / 2;
const toScreen = (docX, docY) => ({
  x: contentOffsetX + docX * scale,
  y: contentOffsetY + docY * scale,
});

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
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let y = docY - half; y < docY + half; y++) {
        for (let x = docX - half; x < docX + half; x++) {
          const i = (y * data.width + x) * 4;
          r += data.data[i]; g += data.data[i + 1]; b += data.data[i + 2]; a += data.data[i + 3];
          n++;
        }
      }
      return { r: r / n, g: g / n, b: b / n, a: a / n };
    },
    { docX, docY, half },
  );

const layerNames = () => page.evaluate(() => window.__clumsyloopEngine.doc.layers.map((l) => l.name));
const activeLayerName = () =>
  page.evaluate(() => {
    const engine = window.__clumsyloopEngine;
    return engine.doc.layers.find((l) => l.id === engine.activeLayerId)?.name;
  });
const layerCount = () => page.evaluate(() => window.__clumsyloopEngine.doc.layers.length);

console.log('\n— Starting state: one layer, active by default —');
check('starts with exactly one layer (Ink)', JSON.stringify(await layerNames()) === JSON.stringify(['Ink']));
check('Ink is the active layer', (await activeLayerName()) === 'Ink');

console.log('\n— Add layer: appears on top, becomes active —');
await page.getByRole('button', { name: 'Add layer' }).click();
check('a second layer now exists', (await layerCount()) === 2);
check('the new layer became active', (await activeLayerName()) !== 'Ink');

console.log('\n— Clicking a different layer row in the panel switches the active layer —');
// Plain getByText('Ink') is ambiguous: 'Ink' is also a brush category
// label and a brush preset name elsewhere on the page. Scope to the
// layers list's own <li><span> row instead.
await page.locator('li span', { hasText: 'Ink' }).click();
check('clicking the Ink row makes it active again', (await activeLayerName()) === 'Ink');

console.log('\n— Strokes land on whichever layer is active —');
await page.evaluate(() => window.__clumsyloopTool.getState().setActiveBrush('fineliner'));
await page.evaluate(() => window.__clumsyloopTool.getState().setActiveColor({ r: 0, g: 0, b: 0 }));
await dragStroke([[60, 100], [200, 100]]);
const inkStroke = await avgAt(130, 100, 3);
check('the stroke landed on the active (Ink) layer', inkStroke.r < 150, JSON.stringify(inkStroke));

console.log('\n— Rename: double-click a layer name, type, commit with Enter —');
const inkRow = page.locator('li', { hasText: 'Ink' });
await inkRow.locator('span', { hasText: 'Ink' }).dblclick();
const renameInput = page.locator('li input');
await renameInput.fill('Background');
await renameInput.press('Enter');
check('the layer was renamed', (await layerNames()).includes('Background'), JSON.stringify(await layerNames()));

console.log('\n— Hide/show: toggling visibility actually removes the layer from the composite —');
await page.getByRole('button', { name: /^Hide Background$/ }).click();
const hiddenComposite = await avgAt(130, 100, 3);
check('hiding the layer with the stroke removes it from the render', hiddenComposite.r > 240, JSON.stringify(hiddenComposite));
await page.getByRole('button', { name: /^Show Background$/ }).click();
const shownComposite = await avgAt(130, 100, 3);
check('showing it again brings the stroke back', shownComposite.r < 150, JSON.stringify(shownComposite));

console.log('\n— Lock: a locked layer refuses new strokes —');
await page.evaluate(() => {
  const engine = window.__clumsyloopEngine;
  const bg = engine.doc.layers.find((l) => l.name === 'Background');
  engine.setActiveLayer(bg.id);
});
await page.getByRole('button', { name: /^Lock Background$/ }).click();
const beforeLockedStroke = await avgAt(130, 300, 3);
await dragStroke([[60, 300], [200, 300]]);
const afterLockedStrokeAttempt = await avgAt(130, 300, 3);
check(
  'a locked layer is untouched by a stroke drawn while it was active',
  Math.abs(afterLockedStrokeAttempt.r - beforeLockedStroke.r) < 5,
  JSON.stringify({ before: beforeLockedStroke, after: afterLockedStrokeAttempt }),
);
await page.getByRole('button', { name: /^Unlock Background$/ }).click();

console.log('\n— Reorder: moving a layer changes its stacking position —');
// Background is the original "Ink" layer, still at the bottom of the
// stack (doc.layers is bottom-to-top) — "move down" from there is a
// legitimate no-op, so this exercises "move up" instead, which isn't.
const namesBeforeMove = await layerNames();
await page.getByRole('button', { name: /^Move Background up$/ }).click();
const namesAfterMove = await layerNames();
check('moving Background up changes the layer order', JSON.stringify(namesBeforeMove) !== JSON.stringify(namesAfterMove), `${JSON.stringify(namesBeforeMove)} -> ${JSON.stringify(namesAfterMove)}`);

console.log('\n— Delete: removes the layer; the last layer cannot be deleted —');
await page.getByRole('button', { name: /^Delete Background$/ }).click();
check('deleting Background leaves only one layer', (await layerCount()) === 1, JSON.stringify(await layerNames()));
const lastLayerName = (await layerNames())[0];
// The panel disables Delete once only one layer is left, so there's
// nothing to click — engine.removeLayer(id) is called directly instead,
// exercising the same refusal the disabled button is protecting against.
const removed = await page.evaluate((name) => {
  const engine = window.__clumsyloopEngine;
  const layer = engine.doc.layers.find((l) => l.name === name);
  return engine.removeLayer(layer.id);
}, lastLayerName);
check('the panel disables Delete once only one layer remains', await page.getByRole('button', { name: new RegExp(`^Delete ${lastLayerName}$`) }).isDisabled());
check('removeLayer() itself refuses to remove the last layer', removed === false && (await layerCount()) === 1, JSON.stringify(await layerNames()));

console.log('\n— Regression: deleting a layer must not leave stale undo entries that can corrupt a different layer later —');
// A Codex review caught this: removeLayer() released a deleted layer's
// GPU surfaces immediately, but earlier stroke/fill/clear commands on
// that layer were still sitting in the undo stack, their closures still
// referencing that now-destroyed surface. WebGL commonly recycles a
// freed texture's object name for the very next createTexture() call —
// so drawing on some OTHER layer right after the deletion (as this test
// does) is exactly the scenario where an old, stale undo entry could
// silently overwrite that unrelated layer's brand-new surface instead of
// failing loudly. Fixed via History.discardForLayer, called from
// removeLayer before it releases anything.
// Renamed via the engine directly (not the UI's rename gesture) purely
// to get distinct, unambiguous names — `addLayer()`'s default "Layer N"
// naming collides with whatever survived the earlier delete-the-last-
// layer test above, and this test cares about identity, not naming UI.
await page.getByRole('button', { name: 'Add layer' }).click();
const doomedLayerId = await page.evaluate(() => window.__clumsyloopEngine.activeLayerId);
await page.evaluate((id) => window.__clumsyloopEngine.renameLayer(id, 'Doomed layer'), doomedLayerId);
await dragStroke([[60, 500], [200, 500]]); // builds a stroke command tagged to this layer
await dragStroke([[60, 550], [200, 550]]); // and a second one, for good measure

await page.getByRole('button', { name: 'Add layer' }).click(); // a different, unrelated layer, active — the doomed one no longer is
const survivorId = await page.evaluate(() => window.__clumsyloopEngine.activeLayerId);
await page.evaluate((id) => window.__clumsyloopEngine.renameLayer(id, 'Survivor layer'), survivorId);

await page.getByRole('button', { name: /^Delete Doomed layer$/ }).click();
check('the doomed layer is gone, the unrelated survivor remains', (await layerCount()) === 2 && (await layerNames()).includes('Survivor layer'), JSON.stringify(await layerNames()));
const stillReferencesDeletedLayer = await page.evaluate(
  (id) => window.__clumsyloopEngine.history.pastCommands.some((c) => c.layerId === id),
  doomedLayerId,
);
check("no undo entry still references the deleted layer's id", !stillReferencesDeletedLayer);

// Immediately create fresh GPU surfaces on the SURVIVING layer — the
// scenario most likely to actually reuse a just-freed GL texture name,
// if anything still could reach it.
await dragStroke([[60, 600], [200, 600]]); // a fresh stroke on the survivor
const survivorInkBefore = await avgAt(130, 600, 3);
check('the fresh stroke on the survivor landed', survivorInkBefore.r < 150, JSON.stringify(survivorInkBefore));

let undoCount = 0;
while (await page.evaluate(() => window.__clumsyloopEngine.history.canUndo)) {
  await page.evaluate(() => window.__clumsyloopEngine.undo());
  undoCount++;
  if (undoCount > 50) break; // guard against an actual infinite loop, not expected
}
check('undoing all the way through history raised no console/page errors', errors.length === 0, errors.join(' | '));
check('the survivor layer still exists after undoing past the deleted layer\'s old (now-discarded) history', (await layerNames()).includes('Survivor layer'));

if (errors.length > 0) {
  check('no console/page errors throughout', false, errors.join(' | '));
}

console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) failed.`}`);
await browser.close();
process.exit(failures === 0 ? 0 : 1);
