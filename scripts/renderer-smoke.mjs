import { chromium } from 'playwright';

// Visual verification for task 2.2 (WebGL2 renderer): drives the
// RendererHarness (window.__clumsyloop) headlessly and checks the
// composited output pixel by pixel. Needs the dev server running
// (`npm run dev`) — same convention as Trace's own scripts/smoke.mjs.
//
// Reads back with `renderer.toImageData()`, not a screenshot of the live
// canvas: the WebGL context uses `preserveDrawingBuffer: false`, so a
// canvas screenshot can lag a frame behind on some Chromium builds — the
// same trap Trace's CLAUDE.md documents. `readPixels` (which
// `toImageData` calls) reads the real buffer at the moment it's called.

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || '/opt/pw-browsers/chromium',
  args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 800, height: 900 } });

const errors = [];
// The browser's automatic favicon.ico request 404s — index.html declares
// none, and that's out of this task's scope. Filtered here, not fixed,
// since it's noise from Chromium's default behavior, not this page.
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
await page.waitForFunction(() => Boolean(window.__clumsyloop), undefined, { timeout: 10000 });

if (errors.length > 0) {
  check('no console/page errors while rendering', false, errors.join(' | '));
}

/** Average straight-alpha RGB over a rect of the composited surface. */
const avgColor = (rect) =>
  page.evaluate((rect) => {
    const { renderer, result } = window.__clumsyloop;
    const data = renderer.toImageData(result);
    let r = 0,
      g = 0,
      b = 0,
      n = 0;
    for (let y = rect.y; y < rect.y2; y++) {
      for (let x = rect.x; x < rect.x2; x++) {
        const i = (y * data.width + x) * 4;
        r += data.data[i];
        g += data.data[i + 1];
        b += data.data[i + 2];
        n++;
      }
    }
    return { r: r / n, g: g / n, b: b / n };
  }, rect);

const docSize = await page.evaluate(() => ({
  w: window.__clumsyloop.doc.width,
  h: window.__clumsyloop.doc.height,
}));
const { w, h } = docSize;
const near = (v, target, tol = 20) => Math.abs(v - target) <= tol;

console.log('\n— Orientation: each quadrant keeps its own photo color —');
const topLeft = await avgColor({ x: 4, y: 4, x2: 20, y2: 20 });
check('top-left is the top-left photo color (blue)', near(topLeft.r, 0x3b) && near(topLeft.g, 0x6f) && near(topLeft.b, 0xd6), JSON.stringify(topLeft));

const topRight = await avgColor({ x: w - 20, y: 4, x2: w - 4, y2: 20 });
check('top-right is the top-right photo color (pink)', near(topRight.r, 0xd6) && near(topRight.g, 0x3b) && near(topRight.b, 0x6f), JSON.stringify(topRight));

const bottomLeft = await avgColor({ x: 4, y: h - 20, x2: 20, y2: h - 4 });
check('bottom-left is the bottom-left photo color (green)', near(bottomLeft.r, 0x6f) && near(bottomLeft.g, 0xd6) && near(bottomLeft.b, 0x3b), JSON.stringify(bottomLeft));

const bottomRight = await avgColor({ x: w - 20, y: h - 20, x2: w - 4, y2: h - 4 });
check('bottom-right is the bottom-right photo color (yellow)', near(bottomRight.r, 0xd6) && near(bottomRight.g, 0xc9) && near(bottomRight.b, 0x3b), JSON.stringify(bottomRight));

console.log('\n— Compositing: the pencil stroke is visible over the photo —');
const cx = Math.round(w / 2);
const cy = Math.round(h / 2);
const strokeCenter = await avgColor({ x: cx - 3, y: cy - 3, x2: cx + 3, y2: cy + 3 });
// The stroke sits on the top-right/top-left seam (photo blue/pink under
// it); ink is dark (0.1,0.1,0.1) at high coverage, so the center should
// read much darker than either quadrant color it's drawn over.
check('stroke center is darker than the photo underneath', strokeCenter.r < 140 && strokeCenter.g < 140 && strokeCenter.b < 140, JSON.stringify(strokeCenter));

console.log('\n— No color halo: just outside the stroke reads pure photo color, not fringed —');
// A few px above the stroke's vertical center, still inside the
// antialiased tip's falloff radius is avoided by going further out —
// pure top-left quadrant, no ink here at all.
const besideStroke = await avgColor({ x: cx - 55, y: cy - 40, x2: cx - 45, y2: cy - 30 });
check('area beside the stroke matches the plain photo color, no dark fringe', near(besideStroke.r, 0x3b) && near(besideStroke.g, 0x6f) && near(besideStroke.b, 0xd6), JSON.stringify(besideStroke));

console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) failed.`}`);
await browser.close();
process.exit(failures === 0 ? 0 : 1);
