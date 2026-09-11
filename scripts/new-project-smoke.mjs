import { chromium } from 'playwright';

// Visual/behavioral verification for the canvas format picker (task 2.15):
// picking a different preset from the "New project" panel actually swaps
// the document's size and gives a fresh, empty document — not just a
// resized copy of whatever was on screen before. Needs the dev server
// running (`npm run dev`).

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

const docSize = () => page.evaluate(() => ({ w: window.__clumsyloopEngine.doc.width, h: window.__clumsyloopEngine.doc.height }));
const layerCount = () => page.evaluate(() => window.__clumsyloopEngine.doc.layers.length);

console.log('— Default project: vertical 9:16 at the original size —');
let size = await docSize();
check('starts at 360x640 (the default preset)', size.w === 360 && size.h === 640, JSON.stringify(size));

console.log('\n— Drawing a stroke, then starting a new project discards it —');
const canvasBox = await page.locator('#drawing-canvas').boundingBox();
await page.mouse.move(canvasBox.x + canvasBox.width / 2 - 10, canvasBox.y + canvasBox.height / 2);
await page.mouse.down();
await page.mouse.move(canvasBox.x + canvasBox.width / 2 + 10, canvasBox.y + canvasBox.height / 2, { steps: 5 });
await page.mouse.up();
await page.waitForFunction(() => {
  const engine = window.__clumsyloopEngine;
  const layer = engine.doc.layers.find((l) => l.id === engine.activeLayerId);
  return layer.cels.size > 0;
});
check('the stroke created a cel', (await page.evaluate(() => window.__clumsyloopEngine.doc.layers[0].cels.size)) > 0);

await page.getByRole('button', { name: 'New project' }).click();
await page.getByRole('button', { name: 'Horizontal 16:9' }).click();
await page.waitForFunction(() => window.__clumsyloopEngine && window.__clumsyloopEngine.doc.width === 640, undefined, { timeout: 10000 });

size = await docSize();
check('switched to 640x360 (horizontal preset)', size.w === 640 && size.h === 360, JSON.stringify(size));
check('the new project has exactly one fresh layer', (await layerCount()) === 1);
check('the new layer has no cels — the old stroke is gone', (await page.evaluate(() => window.__clumsyloopEngine.doc.layers[0].cels.size)) === 0);

console.log('\n— Square preset —');
await page.getByRole('button', { name: 'New project' }).click();
await page.getByRole('button', { name: 'Square 1:1' }).click();
await page.waitForFunction(() => window.__clumsyloopEngine && window.__clumsyloopEngine.doc.width === 480, undefined, { timeout: 10000 });
size = await docSize();
check('switched to 480x480 (square preset)', size.w === 480 && size.h === 480, JSON.stringify(size));

console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) FAILED.`}`);
if (errors.length > 0) {
  console.log('\nConsole errors observed:');
  for (const e of errors) console.log(' ', e);
}
await browser.close();
process.exit(failures > 0 || errors.length > 0 ? 1 : 0);
