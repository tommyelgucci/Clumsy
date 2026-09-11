import { chromium } from 'playwright';

// Visual/behavioral verification for keyframed layer transforms (task
// 2.16): the Transform panel's sliders and keyframe toggles, driven
// through the actual UI, checked against the renderer's own composite —
// not just engine state. Needs the dev server running (`npm run dev`).

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

const engineState = () =>
  page.evaluate(() => {
    const engine = window.__clumsyloopEngine;
    const layer = engine.doc.layers.find((l) => l.id === engine.activeLayerId);
    return {
      currentFrame: engine.currentFrame,
      x: layer.transform.x.base,
      xKeys: layer.transform.x.keys.map((k) => k.frame),
      rotationKeys: layer.transform.rotation.keys.map((k) => k.frame),
    };
  });

/** Reads back a solid stroke's own translation by checking whether ink
 *  lands at a given document point in the CURRENT composite — ground
 *  truth for "did the transform actually move the drawn content", not
 *  just engine-internal channel state. */
const inkAt = (frame, docX, docY, half = 6) =>
  page.evaluate(
    ({ frame, docX, docY, half }) => {
      const engine = window.__clumsyloopEngine;
      const result = engine.renderer.renderDocumentFrame(engine.doc, frame);
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
    { frame, docX, docY, half },
  );

const canvasBox = await page.locator('#drawing-canvas').boundingBox();
const docSize = await page.evaluate(() => ({ w: window.__clumsyloopEngine.doc.width, h: window.__clumsyloopEngine.doc.height }));
const scale = Math.min(canvasBox.width / docSize.w, canvasBox.height / docSize.h);
const contentOffsetX = canvasBox.x + (canvasBox.width - docSize.w * scale) / 2;
const contentOffsetY = canvasBox.y + (canvasBox.height - docSize.h * scale) / 2;
const toScreen = (docX, docY) => ({ x: contentOffsetX + docX * scale, y: contentOffsetY + docY * scale });

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

const P = { x: Math.round(docSize.w / 2), y: Math.round(docSize.h / 2) };

console.log('— Draw a small dot at the center, open the Transform panel —');
await dragStroke([[P.x - 10, P.y], [P.x, P.y], [P.x + 10, P.y]]);
const startInk = await inkAt(0, P.x, P.y, 3);
check('ink exists at P before any transform', startInk < 200, `r=${startInk}`);

await page.getByRole('button', { name: 'Transform' }).click();
const xSlider = page.locator('.cl-slider-row', { has: page.getByText('Position X', { exact: true }) }).locator('input[type=range]');

console.log('\n— Static edit (no keyframes yet): dragging Position X moves the base value —');
let s = await engineState();
check('starts with no X keyframes', s.xKeys.length === 0);
await xSlider.evaluate((el) => {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(el, '80');
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
});
await xSlider.dispatchEvent('pointerup');
s = await engineState();
check('base x moved to 80, still no keyframes', s.x === 80 && s.xKeys.length === 0, JSON.stringify(s));
const movedInk = await inkAt(0, P.x + 80, P.y, 3);
check('the drawn dot actually moved 80px right in the composite', movedInk < 200, `r=${movedInk}`);

console.log('\n— Undo/redo the static edit as a single step —');
await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
s = await engineState();
check('undo restores x to 0 in one step', s.x === 0, JSON.stringify(s));
await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Shift+z' : 'Control+Shift+z');
s = await engineState();
check('redo brings x back to 80', s.x === 80, JSON.stringify(s));

console.log('\n— Keyframing rotation: the stopwatch adds a keyframe at the current frame —');
const rotationKeyBtn = page.locator('.cl-slider-row', { has: page.getByText('Rotation', { exact: true }) }).getByRole('button');
await rotationKeyBtn.click(); // frame 0: adds a keyframe at 0°
s = await engineState();
check('a rotation keyframe now exists at frame 0', s.rotationKeys.includes(0), JSON.stringify(s.rotationKeys));

await page.getByRole('button', { name: 'Next frame' }).click();
s = await engineState();
check('advanced to frame 1', s.currentFrame === 1);

const rotationSlider = page.locator('.cl-slider-row', { has: page.getByText('Rotation', { exact: true }) }).locator('input[type=range]');
await rotationSlider.evaluate((el) => {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(el, '90');
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
});
await rotationSlider.dispatchEvent('pointerup');
s = await engineState();
check('rotation edit at frame 1 (already keyframed) created a NEW keyframe there, not a base change', s.rotationKeys.includes(0) && s.rotationKeys.includes(1), JSON.stringify(s.rotationKeys));

console.log('\n— Removing a keyframe with the stopwatch —');
await rotationKeyBtn.click(); // toggles off the keyframe at frame 1 (current frame)
s = await engineState();
check('the frame-1 rotation keyframe is gone, frame 0 kept', !s.rotationKeys.includes(1) && s.rotationKeys.includes(0), JSON.stringify(s.rotationKeys));

console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) FAILED.`}`);
if (errors.length > 0) {
  console.log('\nConsole errors observed:');
  for (const e of errors) console.log(' ', e);
}
await browser.close();
process.exit(failures > 0 || errors.length > 0 ? 1 : 0);
