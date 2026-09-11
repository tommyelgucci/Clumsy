import { chromium } from 'playwright';

// Visual/behavioral verification for lasso selection (task 2.17): draw
// a closed path, confirm the mask actually bounds a real region, move
// the selected pixels through the actual UI, and confirm the cut/paste
// round-trips correctly with undo. Needs the dev server running
// (`npm run dev`).

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
const scale = Math.min(canvasBox.width / docSize.w, canvasBox.height / docSize.h);
const contentOffsetX = canvasBox.x + (canvasBox.width - docSize.w * scale) / 2;
const contentOffsetY = canvasBox.y + (canvasBox.height - docSize.h * scale) / 2;
const toScreen = (docX, docY) => ({ x: contentOffsetX + docX * scale, y: contentOffsetY + docY * scale });

const drag = async (points, { dwell = true } = {}) => {
  const first = toScreen(...points[0]);
  await page.mouse.move(first.x, first.y);
  await page.mouse.down();
  for (const p of points.slice(1)) {
    const s = toScreen(...p);
    await page.mouse.move(s.x, s.y, { steps: 6 });
  }
  if (dwell) {
    const last = toScreen(...points[points.length - 1]);
    for (let i = 0; i < 10; i++) await page.mouse.move(last.x + (i % 2 === 0 ? 0.5 : -0.5), last.y);
  }
  await page.mouse.up();
};

const avgAtFrame = (docX, docY, half = 4) =>
  page.evaluate(
    ({ docX, docY, half }) => {
      const engine = window.__clumsyloopEngine;
      const result = engine.renderer.renderDocumentFrame(engine.doc, engine.currentFrame);
      const data = engine.renderer.toImageData(result);
      let r = 0, n = 0;
      for (let y = docY - half; y < docY + half; y++) {
        for (let x = docX - half; x < docX + half; x++) {
          r += data.data[(y * data.width + x) * 4];
          n++;
        }
      }
      return r / n;
    },
    { docX, docY, half },
  );

const selectionState = () =>
  page.evaluate(() => {
    const s = window.__clumsyloopEngine.selection;
    return s ? { rect: s.rect, hasMask: s.mask.some((v) => v) } : null;
  });

const P = { x: Math.round(docSize.w / 2), y: Math.round(docSize.h / 2) };

console.log('— Draw a dot, select it with the lasso, confirm the mask covers it —');
await page.getByRole('button', { name: 'Draw' }).click();
await drag([[P.x - 10, P.y], [P.x, P.y], [P.x + 10, P.y]]);
const inkBefore = await avgAtFrame(P.x, P.y);
check('ink exists at P before selecting', inkBefore < 200, `r=${inkBefore}`);

await page.getByRole('button', { name: 'Lasso' }).click();
// A loose circle around P, well outside the tiny dot itself.
const loop = [];
const R = 30;
for (let i = 0; i <= 16; i++) {
  const a = (i / 16) * Math.PI * 2;
  loop.push([P.x + R * Math.cos(a), P.y + R * Math.sin(a)]);
}
await drag(loop, { dwell: false });

let sel = await selectionState();
check('a selection now exists with a non-empty mask', sel !== null && sel.hasMask, JSON.stringify(sel));
check('the selection rect contains P', sel && P.x >= sel.rect.x && P.x < sel.rect.x2 && P.y >= sel.rect.y && P.y < sel.rect.y2, JSON.stringify(sel?.rect));

console.log('\n— Moving the selection: drag from inside it to a new spot —');
const dx = 60;
const dy = 0;
await drag([[P.x, P.y], [P.x + dx, P.y + dy]]);

const inkAtOrigin = await avgAtFrame(P.x, P.y);
check('the origin is empty now — the ink moved away', inkAtOrigin > 250, `r=${inkAtOrigin}`);
const inkAtDest = await avgAtFrame(P.x + dx, P.y + dy);
check('the ink is now at the destination', inkAtDest < 200, `r=${inkAtDest}`);

sel = await selectionState();
check('the selection rect itself moved with it', sel && sel.rect.x > P.x, JSON.stringify(sel?.rect));

console.log('\n— Undo restores both the pixels and the selection position —');
await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
const inkBackAtOrigin = await avgAtFrame(P.x, P.y);
check('undo brings the ink back to the origin', inkBackAtOrigin < 200, `r=${inkBackAtOrigin}`);
const inkGoneFromDest = await avgAtFrame(P.x + dx, P.y + dy);
check('undo removes it from the destination', inkGoneFromDest > 250, `r=${inkGoneFromDest}`);

console.log('\n— Redo moves it again —');
await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Shift+z' : 'Control+Shift+z');
const inkRedoneAtDest = await avgAtFrame(P.x + dx, P.y + dy);
check('redo brings the ink back to the destination', inkRedoneAtDest < 200, `r=${inkRedoneAtDest}`);

console.log('\n— Clicking outside the selection starts a new lasso, not a move —');
const farPoint = { x: Math.round(docSize.w * 0.15), y: Math.round(docSize.h * 0.15) };
const smallLoop = [];
for (let i = 0; i <= 12; i++) {
  const a = (i / 12) * Math.PI * 2;
  smallLoop.push([farPoint.x + 12 * Math.cos(a), farPoint.y + 12 * Math.sin(a)]);
}
await drag(smallLoop, { dwell: false });
sel = await selectionState();
check('a fresh, smaller selection replaced the old one', sel !== null && farPoint.x >= sel.rect.x && farPoint.x < sel.rect.x2, JSON.stringify(sel?.rect));

console.log('\n— Escape clears the selection —');
await page.keyboard.press('Escape');
sel = await selectionState();
check('selection is cleared', sel === null);

console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) FAILED.`}`);
if (errors.length > 0) {
  console.log('\nConsole errors observed:');
  for (const e of errors) console.log(' ', e);
}
await browser.close();
process.exit(failures > 0 || errors.length > 0 ? 1 : 0);
