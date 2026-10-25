import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Verification for the .mp4 export (task 2.4): the file the UI downloads is
// a real H.264 MP4 with the right frame count/fps/size that ffmpeg decodes
// end to end, and the watermark is visible — in the bottom-right corner and
// nowhere else. Needs the dev server (`npm run dev`) plus ffmpeg/ffprobe on
// PATH. Camera frames come from Chromium's fake video device.

const dir = mkdtempSync(join(process.env.EXPORT_SMOKE_DIR || tmpdir(), 'clumsy-export-'));
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || '/opt/pw-browsers/chromium',
  args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
});
const context = await browser.newContext({ viewport: { width: 700, height: 900 }, permissions: ['camera'], acceptDownloads: true });
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

const shutter = page.getByRole('button', { name: 'Shutter' });
for (let i = 0; i < 3; i++) {
  await shutter.click();
  await page.waitForFunction((n) => window.__clumsyloopEngine.doc.layers.find((l) => l.kind === 'camera')?.cels.size === n, i + 1, { timeout: 10000 });
}

console.log('— Export through the UI —');
const [download] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), page.getByRole('button', { name: 'Export video' }).click()]);
const uiPath = join(dir, 'ui.mp4');
await download.saveAs(uiPath);
check('download is named clumsyloop.mp4', download.suggestedFilename() === 'clumsyloop.mp4', download.suggestedFilename());

const probe = JSON.parse(
  execFileSync('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,width,height,r_frame_rate,nb_read_frames,pix_fmt', '-of', 'json', uiPath]).toString(),
).streams[0];
const doc = await page.evaluate(() => ({ w: window.__clumsyloopEngine.doc.width, h: window.__clumsyloopEngine.doc.height, fps: window.__clumsyloopEngine.doc.fps }));
check('codec is H.264', probe.codec_name === 'h264', probe.codec_name);
check('plays in common players (yuv420p)', probe.pix_fmt === 'yuv420p', probe.pix_fmt);
check('three shots export as exactly 3 frames (not the 24-frame timeline)', Number(probe.nb_read_frames) === 3, `frames=${probe.nb_read_frames}`);
check('frame rate matches the document', probe.r_frame_rate === `${doc.fps}/1`, probe.r_frame_rate);
check('size matches the document', probe.width === doc.w && probe.height === doc.h, `${probe.width}x${probe.height} vs ${doc.w}x${doc.h}`);
let decodeOk = true;
try {
  execFileSync('ffmpeg', ['-v', 'error', '-i', uiPath, '-f', 'null', '-'], { stdio: ['ignore', 'ignore', 'pipe'] });
} catch {
  decodeOk = false;
}
check('ffmpeg decodes the whole file without errors', decodeOk);

console.log('\n— Watermark —');
const render = async (watermark) => {
  const b64 = await page.evaluate(async (wm) => {
    const blob = await window.__clumsyloopExportVideo(window.__clumsyloopEngine, { watermark: wm });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }, watermark);
  const path = join(dir, `wm-${watermark}.mp4`);
  writeFileSync(path, Buffer.from(b64, 'base64'));
  return firstFrame(path);
};
const firstFrame = (path) =>
  execFileSync('ffmpeg', ['-v', 'error', '-i', path, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1 << 28 });
/** Pixels differing by more than a codec-noise threshold, split into the
 *  watermark corner and everywhere else. */
const diff = (a, b) => {
  let corner = 0;
  let elsewhere = 0;
  for (let i = 0; i < a.length; i += 3) {
    const d = Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2]));
    if (d < 40) continue;
    const px = i / 3;
    if (px % doc.w > doc.w * 0.45 && Math.floor(px / doc.w) > doc.h * 0.85) corner++;
    else elsewhere++;
  }
  return { corner, elsewhere };
};
const withMark = await render(true);
const without = await render(false);
const marked = diff(withMark, without);
const inside = marked.corner;
const outside = marked.elsewhere;
check('the watermark changes pixels in the bottom-right corner', inside > 200, `pixels=${inside}`);
check('and nowhere else in the frame', outside === 0, `pixels=${outside}`);
const ui = firstFrame(uiPath);
const vsMarked = diff(ui, withMark);
const vsClean = diff(ui, without);
check('the UI export (free plan) matches the watermarked render', vsMarked.corner + vsMarked.elsewhere === 0, JSON.stringify(vsMarked));
check('and differs from the clean render in the corner', vsClean.corner > 200, JSON.stringify(vsClean));
execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', uiPath, '-frames:v', '1', join(dir, 'frame.png')]);
console.log(`  frame saved: ${join(dir, 'frame.png')}`);

console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) FAILED.`}`);
if (errors.length > 0) {
  console.log('\nConsole errors observed:');
  for (const e of errors) console.log(' ', e);
}
await browser.close();
process.exit(failures > 0 || errors.length > 0 ? 1 : 0);
