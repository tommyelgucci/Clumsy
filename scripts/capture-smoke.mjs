import { chromium } from 'playwright';

// Behavioral verification for the capture UI (task 2.3): the shutter turns
// a camera still into a cel on a camera layer, the filmstrip shows it, and
// undo reverses it. Uses Chromium's fake video device through the web
// fallback in src/native/cameraCapture.ts — it exercises the JS side only;
// the AVFoundation plugin itself still needs a physical device (CLAUDE.md).
// Needs the dev server running (`npm run dev`).

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || '/opt/pw-browsers/chromium',
  args: [
    '--enable-unsafe-swiftshader',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
  ],
});
const context = await browser.newContext({ viewport: { width: 700, height: 900 }, permissions: ['camera'] });
const page = await context.newPage();

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

const state = () =>
  page.evaluate(() => {
    const e = window.__clumsyloopEngine;
    const cam = e.doc.layers.find((l) => l.kind === 'camera');
    return {
      layers: e.doc.layers.map((l) => l.kind),
      camFrames: cam ? [...cam.cels.keys()].sort((a, b) => a - b) : [],
      currentFrame: e.currentFrame,
      activeKind: e.doc.layers.find((l) => l.id === e.activeLayerId).kind,
    };
  });
const shutter = page.getByRole('button', { name: 'Shutter' });

console.log('— Shutter —');
let s = await state();
check('starts with no camera layer', !s.layers.includes('camera'), JSON.stringify(s.layers));

for (let i = 0; i < 3; i++) {
  await shutter.click();
  await page.waitForFunction((n) => {
    const cam = window.__clumsyloopEngine.doc.layers.find((l) => l.kind === 'camera');
    return cam && cam.cels.size === n;
  }, i + 1, { timeout: 10000 });
}
s = await state();
check('camera layer sits at the bottom of the stack', s.layers[0] === 'camera' && s.layers.length === 2, JSON.stringify(s.layers));
check('three shots land on consecutive frames 0,1,2', JSON.stringify(s.camFrames) === '[0,1,2]', JSON.stringify(s.camFrames));
check('playhead follows the newest shot', s.currentFrame === 2, `currentFrame=${s.currentFrame}`);
check('active layer is still the drawing layer', s.activeKind === 'draw', s.activeKind);

console.log('\n— Filmstrip —');
const thumbs = page.getByRole('listitem');
check('filmstrip shows the window around the playhead (frames 1-13)', (await thumbs.count()) === 13, `count=${await thumbs.count()}`);
check('newest shot is marked current', (await page.locator('.cl-thumb.is-current').getAttribute('aria-label')) === 'Frame 3');
const nonPaper = (frame) =>
  page.evaluate((f) => {
    const t = window.__clumsyloopEngine.frameThumbnail(f);
    const px = t.getContext('2d').getImageData(0, 0, t.width, t.height).data;
    for (let i = 0; i < px.length; i += 4) if (px[i] < 240 || px[i + 1] < 240 || px[i + 2] < 240) return true;
    return false;
  }, frame);
check('a shot frame has photo content in its thumbnail', await nonPaper(1));
// Cels are sparse and held (core/document.ts `celAt`), so frames past the
// last shot keep showing it — that is the timeline's hold semantic.
check('frames past the last shot hold it (thumbnail is not paper)', await nonPaper(10));
const inkOnly = await page.evaluate(() => {
  const e = window.__clumsyloopEngine;
  e.doc.layers.find((l) => l.kind === 'camera').visible = false;
  const t = e.frameThumbnail(10);
  const px = t.getContext('2d').getImageData(0, 0, t.width, t.height).data;
  e.doc.layers.find((l) => l.kind === 'camera').visible = true;
  return [px[0], px[1], px[2]];
});
check('hiding the camera layer invalidates the cached thumbnail (paper again)', inkOnly.every((v) => v >= 240), JSON.stringify(inkOnly));

await page.locator('.cl-thumb[aria-label="Frame 1"]').click();
s = await state();
check('clicking a thumbnail moves the playhead', s.currentFrame === 0, `currentFrame=${s.currentFrame}`);

console.log('\n— Onion skin over photos —');
await page.locator('.cl-thumb[aria-label="Frame 2"]').click();
await page.getByRole('button', { name: 'Onion skin' }).click();
check('onion skin on with a camera layer renders without error', errors.length === 0, errors.join(' | '));
await page.getByRole('button', { name: 'Onion skin' }).click();

console.log('\n— Undo —');
const undoKey = process.platform === 'darwin' ? 'Meta+z' : 'Control+z';
await page.locator('canvas#drawing-canvas').focus().catch(() => {});
await page.evaluate(() => document.activeElement?.blur?.());
await page.keyboard.press(undoKey);
s = await state();
check('undo removes the newest shot', JSON.stringify(s.camFrames) === '[0,1]', JSON.stringify(s.camFrames));
await page.keyboard.press(undoKey);
await page.keyboard.press(undoKey);
s = await state();
check('undoing the first shot removes the camera layer again', !s.layers.includes('camera'), JSON.stringify(s.layers));

console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) FAILED.`}`);
if (errors.length > 0) {
  console.log('\nConsole errors observed:');
  for (const e of errors) console.log(' ', e);
}
await browser.close();
process.exit(failures > 0 || errors.length > 0 ? 1 : 0);
