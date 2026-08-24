import { chromium } from 'playwright';
import { spawn } from 'node:child_process';

/**
 * Visual/pixel smoke test for task 2.2 (the WebGL2 compositing renderer).
 * Same shape as Trace's `scripts/smoke.mjs`: a Playwright script driving
 * the real dev server, reading pixels back with `gl.readPixels` instead of
 * just eyeballing a screenshot. Uses SwiftShader (`--use-angle=swiftshader`)
 * since this environment has no GPU — the blend-mode/premultiplication math
 * being checked here doesn't depend on hardware acceleration.
 */

const PORT = 5183;
const server = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], {
  stdio: 'pipe',
});
let serverOutput = '';
server.stdout.on('data', (d) => (serverOutput += d));
server.stderr.on('data', (d) => (serverOutput += d));

async function waitForServer() {
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`Dev server didn't come up.\n${serverOutput}`);
}

let failures = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failures++;
};

function closeEnough(a, b, tol = 12) {
  return Math.abs(a - b) <= tol;
}

try {
  await waitForServer();

  const browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'],
  });
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });

  const errors = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => Boolean(window.__clumsy), { timeout: 5000 });

  console.log('\n— Orientation (no Y-flip / axis bug) —');
  // Read the pre-present accumulator directly (document space, row 0 = top,
  // same as the FBO invariant) at each quadrant's center, well inside the
  // soft dot's radius so only the opaque camera photo shows through.
  const quadrants = await page.evaluate(() => {
    const { renderer, doc, lastSurface } = window.__clumsy;
    const gl = renderer.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, lastSurface.fbo);
    const read = (x, y) => {
      const px = new Uint8Array(4);
      gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      return [...px];
    };
    const q = doc.width / 4;
    // Document space is Y-down; near the very corners, outside the dot's
    // radius (0.35 * size from center), so the camera photo shows unmixed.
    const out = {
      topLeft: read(q, q),
      topRight: read(doc.width - q, q),
      bottomLeft: read(q, doc.height - q),
      bottomRight: read(doc.width - q, doc.height - q),
    };
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return out;
  });
  check('top-left quadrant is red (camera photo, not flipped)', closeEnough(quadrants.topLeft[0], 225) && quadrants.topLeft[0] > quadrants.topLeft[2], `rgba=${quadrants.topLeft}`);
  check('top-right quadrant is green', quadrants.topRight[1] > quadrants.topRight[0] && quadrants.topRight[1] > quadrants.topRight[2], `rgba=${quadrants.topRight}`);
  check('bottom-left quadrant is blue', quadrants.bottomLeft[2] > quadrants.bottomLeft[0] && quadrants.bottomLeft[2] > quadrants.bottomLeft[1], `rgba=${quadrants.bottomLeft}`);
  check('bottom-right quadrant is yellow', quadrants.bottomRight[0] > 150 && quadrants.bottomRight[1] > 150 && quadrants.bottomRight[2] < 100, `rgba=${quadrants.bottomRight}`);

  console.log('\n— Screen present matches document orientation (single flip, not zero or two) —');
  const screenTopLeft = await page.evaluate(() => {
    const { renderer, render } = window.__clumsy;
    // Re-render and read back in the same turn: with `preserveDrawingBuffer:
    // false` the browser is free to clear the default framebuffer once it's
    // been presented to the compositor, so a readPixels from an earlier
    // frame (after control has returned to the event loop) can legitimately
    // come back blank — that's a Playwright-script timing artifact, not a
    // renderer bug, and reading right after drawing avoids it.
    render();
    const gl = renderer.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    const px = new Uint8Array(4);
    // Canvas pixel (10,10) — near the visual top-left corner on screen.
    gl.readPixels(10, renderer.canvas.height - 10 - 1, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    return [...px];
  });
  check(
    'the screen shows red top-left too (present() flips exactly once)',
    closeEnough(screenTopLeft[0], 225) && screenTopLeft[0] > screenTopLeft[2],
    `rgba=${screenTopLeft}`,
  );

  console.log('\n— Premultiplied alpha on upload (no color halo) —');
  const premul = await page.evaluate(() => {
    const { renderer, doc } = window.__clumsy;
    const gl = renderer.gl;
    const drawSurface = doc.layers[1].cels.get(0).surface;
    gl.bindFramebuffer(gl.FRAMEBUFFER, drawSurface.fbo);
    const size = doc.width;
    const cx = Math.floor(size / 2);
    const cy = Math.floor(size / 2);
    const samples = [];
    // Walk out from the dot's center to its faded edge: every partial-alpha
    // pixel of a pure-white source must have r===g===b===a once
    // premultiplied — any mismatch means the upload skipped
    // UNPACK_PREMULTIPLY_ALPHA_WEBGL and straight alpha leaked into a
    // premultiplied texture.
    for (let d = 0; d < size / 2; d += 4) {
      const px = new Uint8Array(4);
      gl.readPixels(cx + d, cy, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      samples.push([...px]);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return samples;
  });
  const partialAlphaSamples = premul.filter(([, , , a]) => a > 5 && a < 250);
  check('the soft edge has partial-alpha samples to check', partialAlphaSamples.length > 3, `${partialAlphaSamples.length} samples`);
  const mismatched = partialAlphaSamples.filter(([r, g, b, a]) => !closeEnough(r, a) || !closeEnough(g, a) || !closeEnough(b, a));
  check(
    'every partial-alpha edge pixel is correctly premultiplied (r=g=b=a)',
    mismatched.length === 0,
    mismatched.length ? `${mismatched.length}/${partialAlphaSamples.length} mismatched, e.g. ${mismatched[0]}` : '',
  );

  console.log('\n— All 13 blend modes render without throwing —');
  const blendResult = await page.evaluate(() => {
    const { doc, render } = window.__clumsy;
    const modes = [
      'normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten',
      'colorDodge', 'colorBurn', 'hardLight', 'softLight', 'difference',
      'exclusion', 'add',
    ];
    try {
      for (const m of modes) {
        doc.layers[1].blend = m;
        render();
      }
      doc.layers[1].blend = 'normal';
      render();
      return true;
    } catch (err) {
      return String(err);
    }
  });
  check('all 13 blend modes rendered', blendResult === true, String(blendResult));

  console.log('\n— clipToBelow —');
  const clipResult = await page.evaluate(() => {
    const { renderer, doc, render } = window.__clumsy;
    doc.layers[1].clipToBelow = true;
    render();
    const gl = renderer.gl;
    // Outside the camera layer's bounds there is none here (camera fills
    // the whole document), so instead verify the clipped drawing layer
    // still shows where the (opaque) camera photo is — a real clip-mask
    // regression would only show up against a partially transparent base,
    // but this at least proves clipToBelow doesn't throw or blank the
    // frame outright.
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    const px = new Uint8Array(4);
    gl.readPixels(renderer.canvas.width / 2, renderer.canvas.height / 2, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    doc.layers[1].clipToBelow = false;
    render();
    return [...px];
  });
  check('clipToBelow renders without throwing, center still has content', clipResult[3] > 0, `rgba=${clipResult}`);

  console.log('\n— Onion skin (renderOnionSkin) —');
  await page.waitForFunction(() => Boolean(window.__clumsyOnion), { timeout: 5000 });
  const onionSamples = await page.evaluate(() => {
    const { renderer, lastSurface } = window.__clumsyOnion;
    const gl = renderer.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, lastSurface.fbo);
    const read = (x, y) => {
      const px = new Uint8Array(4);
      gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      return [...px];
    };
    const out = {
      // Frame 0's ghost square (top-left, [20,60)x[20,60)) doesn't overlap
      // frame 1's own square (top-right) — should read pure red tint at
      // opacity 0.4, nothing else contributing.
      beforeGhost: read(40, 40),
      // Frame 2's ghost square (bottom-left) — pure cyan tint at 0.4.
      afterGhost: read(40, 216),
      // Frame 1's own square (top-right, current frame) — full opacity,
      // untinted white, on top of both ghosts.
      current: read(216, 40),
      // Nowhere any square exists — must stay fully transparent.
      empty: read(128, 128),
    };
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return out;
  });
  const near = (v, target, tol = 10) => Math.abs(v - target) <= tol;
  check(
    'before-ghost reads as red at ~40% opacity (tint fully replaces color, opacity controls visibility)',
    near(onionSamples.beforeGhost[0], 102) && near(onionSamples.beforeGhost[1], 0) && near(onionSamples.beforeGhost[2], 0) && near(onionSamples.beforeGhost[3], 102),
    `rgba=${onionSamples.beforeGhost}`,
  );
  check(
    'after-ghost reads as cyan at ~40% opacity',
    near(onionSamples.afterGhost[0], 0) && near(onionSamples.afterGhost[1], 102) && near(onionSamples.afterGhost[2], 102) && near(onionSamples.afterGhost[3], 102),
    `rgba=${onionSamples.afterGhost}`,
  );
  check(
    'the current frame renders fully opaque and untinted on top',
    near(onionSamples.current[0], 255) && near(onionSamples.current[1], 255) && near(onionSamples.current[2], 255) && near(onionSamples.current[3], 255),
    `rgba=${onionSamples.current}`,
  );
  check('empty regions stay fully transparent', onionSamples.empty.every((v) => v === 0), `rgba=${onionSamples.empty}`);

  console.log('\n— Console —');
  // "Failed to load resource: ... 404" is the browser's own message for the
  // favicon request — there's no `public/` folder or <link rel="icon"> in
  // this repo yet — and Chromium doesn't include the URL in console.text()
  // for it, so it's filtered by its generic wording rather than by URL.
  // Unrelated to the renderer under test here.
  const realErrors = errors.filter((e) => !e.startsWith('Failed to load resource'));
  check('no console errors', realErrors.length === 0, realErrors.join(' | '));

  const shotDir = process.env.SHOT_DIR;
  if (shotDir) {
    await page.locator('.composite-canvas').screenshot({ path: `${shotDir}/composite.png` });
    await page.locator('.onion-canvas').screenshot({ path: `${shotDir}/onion.png` });
  }

  console.log(`\n${failures === 0 ? 'ALL GREEN' : `${failures} FAILURE(S)`}\n`);
  await browser.close();
} finally {
  server.kill();
}

process.exit(failures === 0 ? 0 : 1);
