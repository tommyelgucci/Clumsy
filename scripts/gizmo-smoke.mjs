import { chromium } from 'playwright';

// Visual/behavioral verification for the canvas transform gizmo (task
// 2.21): dragging the layer's on-canvas box/handles moves, scales, and
// rotates it, instead of only through the Transform panel's sliders.
// Needs the dev server running (`npm run dev`).

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
const approx = (a, b, tol) => Math.abs(a - b) <= tol;

await page.goto('http://127.0.0.1:5173/', { waitUntil: 'networkidle' });
await page.waitForFunction(() => Boolean(window.__clumsyloopEngine), undefined, { timeout: 15000 });

const canvasBox = await page.locator('#drawing-canvas').boundingBox();
const docSize = await page.evaluate(() => ({ w: window.__clumsyloopEngine.doc.width, h: window.__clumsyloopEngine.doc.height }));
const { w, h } = docSize;
const cx = w / 2;
const cy = h / 2;
const screenScale = Math.min(canvasBox.width / w, canvasBox.height / h);
const contentOffsetX = canvasBox.x + (canvasBox.width - w * screenScale) / 2;
const contentOffsetY = canvasBox.y + (canvasBox.height - h * screenScale) / 2;
const toScreen = (docX, docY) => ({ x: contentOffsetX + docX * screenScale, y: contentOffsetY + docY * screenScale });

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
    { docX: Math.round(docX), docY: Math.round(docY), half },
  );

// Mirrors `DrawingCanvas.tsx`'s own `gizmoGeometry` exactly — same
// `mat3FromTRS`-equivalent math, applied to the same four document-rect
// corners plus the rotate handle — so the test can compute where every
// handle actually is without re-deriving the app's own display geometry
// by hand for each gesture.
const gizmoState = () =>
  page.evaluate(() => {
    const e = window.__clumsyloopEngine;
    const w = e.doc.width;
    const h = e.doc.height;
    const cx = w / 2;
    const cy = h / 2;
    const tx = e.getLayerTransformValue('x');
    const ty = e.getLayerTransformValue('y');
    const scale = e.getLayerTransformValue('scale');
    const rot = e.getLayerTransformValue('rotation');
    const c = Math.cos(rot);
    const s = Math.sin(rot);
    const a = c * scale;
    const b = s * scale;
    const d = -s * scale;
    const ee = c * scale;
    const f = tx + cx - (a * cx + d * cy);
    const g = ty + cy - (b * cx + ee * cy);
    const apply = (px, py) => ({ x: a * px + d * py + f, y: b * px + ee * py + g });
    const handleOffset = Math.max(24, Math.min(w, h) * 0.08);
    return {
      tx, ty, scale, rot,
      corners: [apply(0, 0), apply(w, 0), apply(w, h), apply(0, h)],
      rotateHandle: apply(w / 2, -handleOffset),
      center: apply(cx, cy),
    };
  });

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

const P = { x: Math.round(cx), y: Math.round(cy) };

console.log('— Draw a dot at the center, switch to the Move layer tool —');
await page.getByRole('button', { name: 'Draw' }).click();
await drag([[P.x - 10, P.y], [P.x, P.y], [P.x + 10, P.y]]);
check('ink exists at P before transforming', (await avgAtFrame(P.x, P.y)) < 200);

await page.getByRole('button', { name: 'Move layer' }).click();
let gz = await gizmoState();
check('identity transform: no translate/scale/rotate yet', gz.tx === 0 && gz.ty === 0 && gz.scale === 1 && gz.rot === 0, JSON.stringify(gz));
check(
  'box corners match the plain document rect at identity',
  approx(gz.corners[0].x, 0, 0.01) && approx(gz.corners[0].y, 0, 0.01) && approx(gz.corners[2].x, w, 0.01) && approx(gz.corners[2].y, h, 0.01),
  JSON.stringify(gz.corners),
);

console.log('\n— Move: dragging inside the box translates the layer —');
const moveDx = Math.round(w * 0.05);
const moveDy = Math.round(h * 0.15);
const grabInside = { x: Math.round(w * 0.35), y: Math.round(h * 0.35) };
await drag([[grabInside.x, grabInside.y], [grabInside.x + moveDx, grabInside.y + moveDy]]);

gz = await gizmoState();
check('x moved by roughly the drag delta', approx(gz.tx, moveDx, 3), `tx=${gz.tx}`);
check('y moved by roughly the drag delta', approx(gz.ty, moveDy, 3), `ty=${gz.ty}`);
check('the ink moved away from its original spot', (await avgAtFrame(P.x, P.y)) > 250);
check('the ink now shows at the translated spot', (await avgAtFrame(P.x + gz.tx, P.y + gz.ty)) < 200);

console.log('\n— Scale: dragging a corner handle scales the layer about its center —');
gz = await gizmoState();
const topLeft = gz.corners[0];
check('the top-left corner sits where the translate put it', approx(topLeft.x, gz.tx, 2) && approx(topLeft.y, gz.ty, 2), JSON.stringify(topLeft));

const scaleFactor = 1.06;
const scaleTarget = { x: gz.center.x + scaleFactor * (topLeft.x - gz.center.x), y: gz.center.y + scaleFactor * (topLeft.y - gz.center.y) };
await drag([[topLeft.x, topLeft.y], [scaleTarget.x, scaleTarget.y]]);

gz = await gizmoState();
check('scale grew by roughly the drag ratio', approx(gz.scale, scaleFactor, 0.03), `scale=${gz.scale}`);

console.log('\n— Rotate: dragging the rotate handle spins the layer about its center —');
gz = await gizmoState();
const startAngle = Math.atan2(gz.rotateHandle.y - gz.center.y, gz.rotateHandle.x - gz.center.x);
const handleDist = dist(gz.rotateHandle, gz.center);
const deltaRot = Math.PI / 4;
const rotateTarget = { x: gz.center.x + handleDist * Math.cos(startAngle + deltaRot), y: gz.center.y + handleDist * Math.sin(startAngle + deltaRot) };
await drag([[gz.rotateHandle.x, gz.rotateHandle.y], [rotateTarget.x, rotateTarget.y]]);

gz = await gizmoState();
check('rotation advanced by roughly the drag angle', approx(gz.rot, deltaRot, 0.08), `rot=${gz.rot}`);

console.log('\n— Undo unwinds move/scale/rotate one commit at a time —');
const undoKey = process.platform === 'darwin' ? 'Meta+z' : 'Control+z';
const redoKey = process.platform === 'darwin' ? 'Meta+Shift+z' : 'Control+Shift+z';

await page.keyboard.press(undoKey); // undo rotate
gz = await gizmoState();
check('undo #1 reverts rotation only', approx(gz.rot, 0, 0.01) && approx(gz.scale, scaleFactor, 0.03), JSON.stringify(gz));

await page.keyboard.press(undoKey); // undo scale
gz = await gizmoState();
check('undo #2 also reverts scale', approx(gz.scale, 1, 0.01) && approx(gz.ty, moveDy, 3), JSON.stringify(gz));

await page.keyboard.press(undoKey); // undo move's y commit
await page.keyboard.press(undoKey); // undo move's x commit
gz = await gizmoState();
check('undoing the move (two separate commits, x and y) restores identity', gz.tx === 0 && gz.ty === 0, JSON.stringify(gz));
check('the ink is back at its original spot', (await avgAtFrame(P.x, P.y)) < 200);

console.log('\n— Redo replays all four commits back —');
for (let i = 0; i < 4; i++) await page.keyboard.press(redoKey);
gz = await gizmoState();
check('redo restores the translate', approx(gz.tx, moveDx, 3) && approx(gz.ty, moveDy, 3), JSON.stringify(gz));
check('redo restores the scale', approx(gz.scale, scaleFactor, 0.03), `scale=${gz.scale}`);
check('redo restores the rotation', approx(gz.rot, deltaRot, 0.08), `rot=${gz.rot}`);

console.log('\n— A drag starting outside the (now smaller) box is a no-op —');
gz = await gizmoState();
// Shrink well below the current size so there's real dead space between
// the box and the canvas edges to click into.
const shrinkTarget = { x: gz.center.x + 0.3 * (gz.corners[0].x - gz.center.x), y: gz.center.y + 0.3 * (gz.corners[0].y - gz.center.y) };
await drag([[gz.corners[0].x, gz.corners[0].y], [shrinkTarget.x, shrinkTarget.y]]);
const beforeMiss = await gizmoState();
await drag([[2, 2], [40, 40]], { dwell: false });
const afterMiss = await gizmoState();
check(
  'a drag starting outside the shrunk box changes nothing',
  approx(afterMiss.tx, beforeMiss.tx, 0.01) &&
    approx(afterMiss.ty, beforeMiss.ty, 0.01) &&
    approx(afterMiss.scale, beforeMiss.scale, 0.001) &&
    approx(afterMiss.rot, beforeMiss.rot, 0.001),
  JSON.stringify({ beforeMiss, afterMiss }),
);

console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) FAILED.`}`);
if (errors.length > 0) {
  console.log('\nConsole errors observed:');
  for (const e of errors) console.log(' ', e);
}
await browser.close();
process.exit(failures > 0 || errors.length > 0 ? 1 : 0);
