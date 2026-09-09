import { chromium } from 'playwright';

// Visual/behavioral verification for the interactive drawing UI
// (DrawingCanvas + gl/engine.ts): drives real pointer events (not
// synthetic Stamp arrays, unlike renderer-smoke.mjs) through the actual
// on-screen canvas, then reads back the composited result the same
// deterministic way (renderer.toImageData(), not a canvas screenshot —
// see renderer-smoke.mjs's note on preserveDrawingBuffer). Needs the dev
// server running (`npm run dev`).

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

/** Plain average over a small box — fine for large blank/solid areas. */
const avgAt = (docX, docY, half = 8) =>
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

/** Darkest (min-R) pixel in a band around a horizontal stroke — a thin
 *  6px-diameter pencil line only covers a sliver of any reasonably-sized
 *  averaging box, so an average washes it out to near-white; scanning
 *  for the darkest pixel actually answers "is there ink here at all,"
 *  regardless of the exact line width/position within the band. */
const darkestInBand = (x1, x2, y, bandHalf = 12) =>
  page.evaluate(
    ({ x1, x2, y, bandHalf }) => {
      const engine = window.__clumsyloopEngine;
      const result = engine.renderer.renderDocumentFrame(engine.doc, 0);
      const data = engine.renderer.toImageData(result);
      let min = { r: 255, g: 255, b: 255 };
      for (let x = x1; x < x2; x++) {
        for (let py = y - bandHalf; py < y + bandHalf; py++) {
          const i = (py * data.width + x) * 4;
          if (data.data[i] + data.data[i + 1] + data.data[i + 2] < min.r + min.g + min.b) {
            min = { r: data.data[i], g: data.data[i + 1], b: data.data[i + 2] };
          }
        }
      }
      return min;
    },
    { x1, x2, y, bandHalf },
  );

const canvasBox = await page.locator('#drawing-canvas').boundingBox();
const docSize = await page.evaluate(() => ({ w: window.__clumsyloopEngine.doc.width, h: window.__clumsyloopEngine.doc.height }));
// CSS display size vs. the document's actual pixel size — needed to turn a
// document-space target point into real screen coordinates for page.mouse.
const toScreen = (docX, docY) => ({
  x: canvasBox.x + (docX / docSize.w) * canvasBox.width,
  y: canvasBox.y + (docY / docSize.h) * canvasBox.height,
});

const drawLine = async (x1, y1, x2, y2) => {
  const a = toScreen(x1, y1);
  const b = toScreen(x2, y2);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 5 });
  await page.mouse.move(b.x, b.y, { steps: 5 });
  await page.mouse.up();
};

console.log('\n— Blank canvas starts white (default paper) —');
const blank = await avgAt(40, 40);
check('top-left starts opaque white', blank.r > 240 && blank.g > 240 && blank.b > 240 && blank.a === 255, JSON.stringify(blank));

console.log('\n— A real pointer-driven stroke draws ink (default pencil, dark) —');
await drawLine(80, 300, 200, 300);
const inkStroke = await darkestInBand(80, 200, 300);
check('the drawn line is dark ink, not blank paper', inkStroke.r < 150, JSON.stringify(inkStroke));

console.log('\n— Switching color mid-session affects the NEXT stroke, not the one already drawn —');
await page.evaluate(() => window.__clumsyloopTool.getState().setActiveColor({ r: 0.9, g: 0.1, b: 0.1 }));
await drawLine(80, 450, 200, 450);
const redStroke = await darkestInBand(80, 200, 450);
check('the new stroke is reddish (R clearly above G/B)', redStroke.r > 150 && redStroke.r - redStroke.g > 60 && redStroke.r - redStroke.b > 60, JSON.stringify(redStroke));
const oldInkUnchanged = await darkestInBand(80, 200, 300);
check('the earlier dark stroke is unaffected by the later color switch', JSON.stringify(oldInkUnchanged) === JSON.stringify(inkStroke), `before ${JSON.stringify(inkStroke)} -> now ${JSON.stringify(oldInkUnchanged)}`);

console.log('\n— The eraser brush removes ink instead of adding color —');
await page.evaluate(() => window.__clumsyloopTool.getState().setActiveBrush('eraser'));
await drawLine(60, 300, 220, 300);
const erasedArea = await avgAt(140, 300, 15);
check('after erasing, the area averages much closer to blank paper', erasedArea.r > 240, JSON.stringify(erasedArea));

console.log('\n— Clear resets the whole layer —');
await page.getByRole('button', { name: 'Clear' }).click();
const cleared = await avgAt(140, 450, 20);
check('after Clear, the red stroke area is back to blank paper', cleared.r > 240 && cleared.g > 240 && cleared.b > 240, JSON.stringify(cleared));

if (errors.length > 0) {
  check('no console/page errors throughout', false, errors.join(' | '));
}

console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) failed.`}`);
await browser.close();
process.exit(failures === 0 ? 0 : 1);
