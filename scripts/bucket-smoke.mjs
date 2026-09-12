import { chromium } from 'playwright';

// Visual/behavioral verification for the bucket fill tool (task 2.7):
// real pointer-drawn outlines (fineliner, a thin hard-edged brush — not
// synthetic Stamp arrays), a real bucket click through the UI, and the
// gap-closure pipeline exercised end to end (pointer draw -> worker ->
// GPU write-back), not just the core/flood.ts unit tests' synthetic
// pixel buffers. Needs the dev server running (`npm run dev`).
//
// floodFill is async (a Worker round trip) and the UI's click handler
// fires it without awaiting (`void engine.floodFill(...)`) — a plain
// `page.mouse.click()` returns as soon as the DOM event finishes
// dispatching, well before the fill lands. Every fill below is followed
// by polling the active cel's `surface.version` (bumped by `writeRect`)
// instead of a fixed sleep, so this doesn't guess at how long a fill
// takes.

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

/**
 * Drags a real pointer through `points` (document space) — building a
 * closed outline out of straight strokes needs each stroke to actually
 * *reach* its declared endpoint, which took a real debugging session to
 * get right: the brush's One Euro smoothing filter (ported verbatim from
 * Trace) has a genuine steady-state lag behind constant-velocity motion
 * — confirmed directly by calling engine.beginStroke/pushStroke/endStroke
 * with dense synthetic samples and watching the line stop several
 * pixels short of the target regardless of step count. A real hand
 * naturally slows down and lingers for an instant at a stroke's end;
 * lifting the pointer the moment it arrives (what a naive scripted drag
 * does) undershoots. Dwelling here — small back-and-forth jitter at the
 * final point — reproduces that lingering and lets the filter converge;
 * this is a real, permanent property of the brush engine, not a bug to
 * fix, so it's the test's job to imitate a real drag, not the app's.
 */
const dragStroke = async (points) => {
  const first = toScreen(...points[0]);
  await page.mouse.move(first.x, first.y);
  await page.mouse.down();
  for (const p of points.slice(1)) {
    const s = toScreen(...p);
    await page.mouse.move(s.x, s.y, { steps: 8 });
  }
  const last = toScreen(...points[points.length - 1]);
  for (let i = 0; i < 30; i++) {
    await page.mouse.move(last.x + (i % 2 === 0 ? 0.5 : -0.5), last.y);
  }
  await page.mouse.up();
};

const avgAt = (docX, docY, half = 6) =>
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

const setBrush = (id) => page.evaluate((id) => window.__clumsyloopTool.getState().setActiveBrush(id), id);
const setColor = (color) => page.evaluate((color) => window.__clumsyloopTool.getState().setActiveColor(color), color);
const setMode = (mode) => page.evaluate((mode) => window.__clumsyloopTool.getState().setMode(mode), mode);

const activeCelVersion = () =>
  page.evaluate(() => {
    const engine = window.__clumsyloopEngine;
    const layer = engine.doc.layers.find((l) => l.id === engine.activeLayerId);
    const cel = layer.cels.get(0);
    return cel ? cel.surface.version : -1;
  });

/** Clicks to fill, then waits for the active cel's `surface.version` to
 *  actually bump — see the file header on why a fixed sleep won't do. */
const clickAndWaitForFill = async (docX, docY) => {
  const before = await activeCelVersion();
  const s = toScreen(docX, docY);
  await page.mouse.click(s.x, s.y);
  await page.waitForFunction(
    (before) => {
      const engine = window.__clumsyloopEngine;
      const layer = engine.doc.layers.find((l) => l.id === engine.activeLayerId);
      const cel = layer.cels.get(0);
      return Boolean(cel) && cel.surface.version > before;
    },
    before,
    { timeout: 10000 },
  );
};

const drawRect = async (x1, y1, x2, y2) => {
  await dragStroke([[x1, y1], [x2, y1]]);
  await dragStroke([[x2, y1], [x2, y2]]);
  await dragStroke([[x2, y2], [x1, y2]]);
  await dragStroke([[x1, y2], [x1, y1]]);
};

await setBrush('fineliner');
await setColor({ r: 0, g: 0, b: 0 });

console.log('\n— Basic bucket fill: stays inside a closed outline, ink untouched —');
await drawRect(60, 60, 200, 200);
await setMode('bucket');
await setColor({ r: 0.1, g: 0.7, b: 0.2 }); // green fill
await clickAndWaitForFill(130, 130);
const inside = await avgAt(130, 130);
check('inside the outline is now green', inside.g > 150 && inside.r < 150, JSON.stringify(inside));
const outside = await avgAt(230, 230);
check('outside the outline is still blank paper', outside.r > 240 && outside.g > 240 && outside.b > 240, JSON.stringify(outside));
const onLine = await avgAt(130, 60, 2);
check('the ink outline itself is untouched (still dark)', onLine.r < 100 && onLine.g < 100 && onLine.b < 100, JSON.stringify(onLine));

// Document is 360x640 (DrawingCanvas.tsx) — this rectangle must fit
// inside that, not just "look reasonable" on paper; the first draft used
// x up to 420 and silently drew nothing there at all.
console.log('\n— Gap closure: a real ~3px break in the outline still contains the fill —');
await page.evaluate(() => window.__clumsyloopEngine.clearActiveLayer());
await setMode('draw');
await setColor({ r: 0, g: 0, b: 0 });
// Same rectangle shape, with the top edge split into two strokes leaving
// a real gap — not just a lighter/antialiased pixel.
await dragStroke([[200, 320], [260, 320]]);
await dragStroke([[263, 320], [340, 320]]); // ~3px gap between 260 and 263, within default gapClose=2's ~4px reach
await dragStroke([[340, 320], [340, 460]]);
await dragStroke([[340, 460], [200, 460]]);
await dragStroke([[200, 460], [200, 320]]);
await setMode('bucket');
await setColor({ r: 0.8, g: 0.2, b: 0.2 }); // red fill
await clickAndWaitForFill(270, 390);
const containedInside = await avgAt(270, 390);
check('fill lands inside the gapped rectangle', containedInside.r > 150 && containedInside.g < 150, JSON.stringify(containedInside));
const containedOutside = await avgAt(270, 250); // above the rectangle, past the gap
check('with gap closure (default), the fill does NOT leak out through the ~3px gap', containedOutside.r > 240 && containedOutside.g > 240, JSON.stringify(containedOutside));

console.log('\n— Same gapped rectangle, gap closure OFF: the fill DOES leak (proves the knob matters) —');
await page.evaluate(() => window.__clumsyloopEngine.clearActiveLayer());
await setMode('draw');
await setColor({ r: 0, g: 0, b: 0 });
await dragStroke([[200, 320], [260, 320]]);
await dragStroke([[263, 320], [340, 320]]);
await dragStroke([[340, 320], [340, 460]]);
await dragStroke([[340, 460], [200, 460]]);
await dragStroke([[200, 460], [200, 320]]);
const beforeLeakVersion = await activeCelVersion();
await page.evaluate(() => window.__clumsyloopEngine.floodFill(270, 390, { r: 0.8, g: 0.2, b: 0.2 }, 0.15, 2, 0));
await page.waitForFunction(
  (before) => {
    const engine = window.__clumsyloopEngine;
    const layer = engine.doc.layers.find((l) => l.id === engine.activeLayerId);
    const cel = layer.cels.get(0);
    return Boolean(cel) && cel.surface.version > before;
  },
  beforeLeakVersion,
  { timeout: 10000 },
);
const leaked = await avgAt(270, 250);
check('with gap closure OFF (0), the fill leaks out through the same gap', !(leaked.r > 240 && leaked.g > 240), JSON.stringify(leaked));

console.log('\n— Reference-layer fill: paints the active layer using another visible layer as the boundary —');
await page.evaluate(() => window.__clumsyloopEngine.clearActiveLayer());
const layerSetup = await page.evaluate(() => {
  const engine = window.__clumsyloopEngine;
  const doc = engine.doc;
  const inkLayer = doc.layers[0];
  // A fresh "Color" layer, added BELOW the ink layer (bottom of the
  // stack) — the composited reference the bucket reads includes both,
  // but the write only ever goes to whichever one is active.
  const colorLayer = { ...inkLayer, id: 'color-layer', name: 'Color', kind: 'draw', cels: new Map(), transform: { ...inkLayer.transform } };
  doc.layers.unshift(colorLayer);
  return { inkLayerId: inkLayer.id, colorLayerId: colorLayer.id };
});
await setBrush('fineliner');
await setColor({ r: 0, g: 0, b: 0 });
await drawRect(60, 500, 200, 620); // drawn on the still-active ink layer
await page.evaluate((id) => window.__clumsyloopEngine.setActiveLayer(id), layerSetup.colorLayerId);
const beforeRefVersion = -1; // the color layer has no cel yet — any version after creation counts
await page.evaluate(({ x, y }) => window.__clumsyloopEngine.floodFill(x, y, { r: 0.2, g: 0.3, b: 0.9 }, 0.15, 2, 2), { x: 130, y: 560 });
await page.waitForFunction(
  ({ colorLayerId, before }) => {
    const engine = window.__clumsyloopEngine;
    const layer = engine.doc.layers.find((l) => l.id === colorLayerId);
    const cel = layer.cels.get(0);
    return Boolean(cel) && cel.surface.version > before;
  },
  { colorLayerId: layerSetup.colorLayerId, before: beforeRefVersion },
  { timeout: 10000 },
);
const refResult = await page.evaluate(
  ({ inkLayerId, colorLayerId }) => {
    const engine = window.__clumsyloopEngine;
    const doc = engine.doc;
    const ink = doc.layers.find((l) => l.id === inkLayerId);
    const color = doc.layers.find((l) => l.id === colorLayerId);
    const readAt = (layer, x, y) => {
      const cel = layer.cels.get(0);
      if (!cel) return null;
      const data = engine.renderer.toImageData(cel.surface);
      const i = (y * data.width + x) * 4;
      return { r: data.data[i], g: data.data[i + 1], b: data.data[i + 2], a: data.data[i + 3] };
    };
    return { inkAtFillPoint: readAt(ink, 130, 560), colorAtFillPoint: readAt(color, 130, 560) };
  },
  layerSetup,
);
check("the fill landed on the Color layer's own cel (blue)", refResult.colorAtFillPoint && refResult.colorAtFillPoint.b > 150 && refResult.colorAtFillPoint.r < 150, JSON.stringify(refResult.colorAtFillPoint));
check("the Ink layer's cel is untouched by the fill (still just the outline, transparent inside)", refResult.inkAtFillPoint && refResult.inkAtFillPoint.a === 0, JSON.stringify(refResult.inkAtFillPoint));

if (errors.length > 0) {
  check('no console/page errors throughout', false, errors.join(' | '));
}

console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) failed.`}`);
await browser.close();
process.exit(failures === 0 ? 0 : 1);
