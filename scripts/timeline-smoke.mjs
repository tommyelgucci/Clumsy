import { chromium } from 'playwright';

// Visual/behavioral verification for the timeline (task 2.14): frame
// navigation, add/duplicate/delete a cel on the active layer, undo/redo
// of those actions, onion skin, and the fps setter — all through the
// actual UI. Needs the dev server running (`npm run dev`).

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
// See scripts/undo-smoke.mjs for why this isn't a naive canvasBox.width/
// height scale — object-fit:contain can letterbox the canvas.
const scale = Math.min(canvasBox.width / docSize.w, canvasBox.height / docSize.h);
const contentOffsetX = canvasBox.x + (canvasBox.width - docSize.w * scale) / 2;
const contentOffsetY = canvasBox.y + (canvasBox.height - docSize.h * scale) / 2;
const toScreen = (docX, docY) => ({ x: contentOffsetX + docX * scale, y: contentOffsetY + docY * scale });

/** See scripts/bucket-smoke.mjs for why the dwell at the end matters
 *  (the ported One Euro filter's real steady-state lag). */
const dragStroke = async (points) => {
  const first = toScreen(...points[0]);
  await page.mouse.move(first.x, first.y);
  await page.mouse.down();
  for (const p of points.slice(1)) {
    const s = toScreen(...p);
    await page.mouse.move(s.x, s.y, { steps: 8 });
  }
  const last = toScreen(...points[points.length - 1]);
  for (let i = 0; i < 15; i++) await page.mouse.move(last.x + (i % 2 === 0 ? 0.5 : -0.5), last.y);
  await page.mouse.up();
};

/** Ground truth for what a given frame's own cels actually composite to
 *  — bypasses onion entirely, since `renderDocumentFrame` doesn't know
 *  about it, so this is unaffected by the onion toggle either way. */
const avgAtFrame = (frame, docX, docY, half = 10) =>
  page.evaluate(
    ({ frame, docX, docY, half }) => {
      const engine = window.__clumsyloopEngine;
      const result = engine.renderer.renderDocumentFrame(engine.doc, frame);
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
    { frame, docX, docY, half },
  );

/** Reads back the exact scratch surface `Engine.renderAndPresent`'s onion
 *  branch feeds into `present()` — avoids any ambiguity about the
 *  present pass's own screen-space Y-flip (see CLAUDE.md's note on why a
 *  live canvas screenshot isn't a reliable way to check a WebGL render;
 *  this sidesteps that entirely by reading the source surface instead of
 *  the presented framebuffer). Only meaningful right after a render with
 *  onion skin ON — with it off, `renderAndPresent` never touches this
 *  scratch, so it holds whatever the last onion-enabled render left. */
const avgOnionSurface = (docX, docY, half = 10) =>
  page.evaluate(
    ({ docX, docY, half }) => {
      const engine = window.__clumsyloopEngine;
      const surface = engine.renderer.scratch('onionAcc');
      const data = engine.renderer.toImageData(surface);
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

const frameState = () =>
  page.evaluate(() => {
    const engine = window.__clumsyloopEngine;
    const layer = engine.doc.layers.find((l) => l.id === engine.activeLayerId);
    return {
      currentFrame: engine.currentFrame,
      frameCount: engine.doc.frameCount,
      celFrames: [...layer.cels.keys()].sort((a, b) => a - b),
      onion: engine.onionSkinEnabled,
      fps: engine.doc.fps,
    };
  });

const P = { x: Math.round(docSize.w / 2), y: Math.round(docSize.h / 2) };
const Q = { x: Math.round(docSize.w / 4), y: Math.round(docSize.h / 4) };

console.log('— Starting state: frame 1 of 24, no cel yet —');
let s = await frameState();
check('starts on frame 0', s.currentFrame === 0, `currentFrame=${s.currentFrame}`);
check('doc starts with 24 frames', s.frameCount === 24, `frameCount=${s.frameCount}`);
check('the fresh Ink layer has no cel yet', s.celFrames.length === 0);

console.log('\n— Drawing on frame 0, then adding a new (blank) frame —');
await dragStroke([[P.x - 20, P.y], [P.x, P.y], [P.x + 20, P.y]]);
const frame0Ink = await avgAtFrame(0, P.x, P.y, 3);
check('frame 0 has visible ink at P', frame0Ink.r < 200, JSON.stringify(frame0Ink));

await page.getByRole('button', { name: 'New frame' }).click();
s = await frameState();
check('advanced to frame 1', s.currentFrame === 1, `currentFrame=${s.currentFrame}`);
check('a new cel exists at frame 1', s.celFrames.includes(1), JSON.stringify(s.celFrames));
const frame1Blank = await avgAtFrame(1, P.x, P.y);
check('frame 1 is blank paper at P — a separate cel, not a copy', frame1Blank.r > 250, JSON.stringify(frame1Blank));

console.log('\n— Frame isolation: drawing on frame 1 does not touch frame 0 —');
await dragStroke([[Q.x - 20, Q.y], [Q.x, Q.y], [Q.x + 20, Q.y]]);
const frame1Ink = await avgAtFrame(1, Q.x, Q.y, 3);
check('frame 1 has ink at Q', frame1Ink.r < 200, JSON.stringify(frame1Ink));
const frame0StillClean = await avgAtFrame(0, Q.x, Q.y);
check('frame 0 is untouched at Q', frame0StillClean.r > 250, JSON.stringify(frame0StillClean));
const frame0StillHasP = await avgAtFrame(0, P.x, P.y, 3);
check("frame 0's own ink at P survived", frame0StillHasP.r < 200, JSON.stringify(frame0StillHasP));

console.log('\n— Previous frame: navigates back to frame 0 —');
await page.getByRole('button', { name: 'Previous frame' }).click();
s = await frameState();
check('back on frame 0', s.currentFrame === 0, `currentFrame=${s.currentFrame}`);
await page.getByRole('button', { name: 'Next frame' }).click();
s = await frameState();
check('forward to frame 1 again', s.currentFrame === 1, `currentFrame=${s.currentFrame}`);

console.log('\n— Duplicate frame: copies the held cel’s pixels into a new one —');
await page.getByRole('button', { name: 'Duplicate frame' }).click();
s = await frameState();
check('advanced to frame 2', s.currentFrame === 2, `currentFrame=${s.currentFrame}`);
check('frame 2 has its own cel', s.celFrames.includes(2), JSON.stringify(s.celFrames));
const frame2Copy = await avgAtFrame(2, Q.x, Q.y, 3);
check("frame 2 carries frame 1's ink at Q (duplicated)", frame2Copy.r < 200, JSON.stringify(frame2Copy));

console.log('\n— Delete frame: removes the cel that starts exactly here —');
await page.getByRole('button', { name: 'Delete frame' }).click();
s = await frameState();
check('frame 2 no longer has its own cel', !s.celFrames.includes(2), JSON.stringify(s.celFrames));
check('still sitting on frame 2 (delete does not navigate)', s.currentFrame === 2, `currentFrame=${s.currentFrame}`);
const frame2FallsBack = await avgAtFrame(2, Q.x, Q.y, 3);
check("frame 2 now shows frame 1's held cel again", frame2FallsBack.r < 200, JSON.stringify(frame2FallsBack));

console.log('\n— Undo/redo restore the deleted frame and the frame count growth —');
await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z'); // undo delete
s = await frameState();
check('undoing the delete brings frame 2’s cel back', s.celFrames.includes(2), JSON.stringify(s.celFrames));
await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z'); // undo duplicate (frame 2 creation)
await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z'); // undo the frame-1 stroke
await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z'); // undo the frame-1 cel creation (New frame)
s = await frameState();
check('undoing New frame removes frame 1’s cel entirely', !s.celFrames.includes(1), JSON.stringify(s.celFrames));
check('frameCount is still 24 (frame 2 never exceeded the initial count, so growth never triggered)', s.frameCount === 24, `frameCount=${s.frameCount}`);

console.log('\n— Onion skin: shows the previous frame as a faint ghost, without touching real pixels —');
// Redo back to having ink on frame 0 and a blank frame 1 to onion-skin against.
await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Shift+z' : 'Control+Shift+z'); // redo New frame
s = await frameState();
check('back on frame 1 after redo', s.currentFrame === 1, `currentFrame=${s.currentFrame}`);
await page.getByRole('button', { name: 'Onion skin' }).click();
s = await frameState();
check('onion skin toggled on', s.onion === true);

const ghostAtP = await avgOnionSurface(P.x, P.y);
check("onion surface shows a faint ghost of frame 0's ink at P (not pure white)", ghostAtP.r < 250 && ghostAtP.r > 100, JSON.stringify(ghostAtP));
const frame1StillBlankAtP = await avgAtFrame(1, P.x, P.y);
check("frame 1's own data at P is still blank — the ghost lives only in the onion overlay", frame1StillBlankAtP.r > 250, JSON.stringify(frame1StillBlankAtP));

await page.getByRole('button', { name: 'Onion skin' }).click();
s = await frameState();
check('onion skin toggled back off', s.onion === false);

console.log('\n— FPS: the input field edits doc.fps —');
const fpsInput = page.locator('.cl-fps-input input');
await fpsInput.fill('24');
await fpsInput.dispatchEvent('change');
s = await frameState();
check('fps updated to 24', s.fps === 24, `fps=${s.fps}`);

console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) FAILED.`}`);
if (errors.length > 0) {
  console.log('\nConsole errors observed:');
  for (const e of errors) console.log(' ', e);
}
await browser.close();
process.exit(failures > 0 || errors.length > 0 ? 1 : 0);
