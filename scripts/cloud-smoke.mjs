import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// End-to-end check of the cloud client (tasks 3.5, 4.1-4.3, 5.1) against the
// local Auth/Firestore/Storage emulators, with two separate signed-in users
// driving the real UI: publish a clip, see it in the feed, report it, block
// an author, delete your own, and have the export watermark follow the
// entitlement. Needs ffmpeg/ffprobe, and the app served with
// VITE_USE_FIREBASE_EMULATORS=true, e.g.:
//
//   VITE_USE_FIREBASE_EMULATORS=true npx vite --port 5174 &
//   firebase emulators:exec --only auth,firestore,storage \
//     --project demo-clumsyloop 'npm run test:cloud-smoke'
//
// The moderation Cloud Function can't run in this sandbox's emulator suite
// (see tasks.json 5.2), so the one thing it would do — set `hidden` on a
// reported clip — is simulated with an admin write, and labeled as such.

const APP = process.env.APP_URL || 'http://127.0.0.1:5174/';
const FS = 'http://127.0.0.1:8080/v1/projects/demo-clumsyloop/databases/(default)/documents';
const dir = mkdtempSync(join(process.env.EXPORT_SMOKE_DIR || tmpdir(), 'clumsy-cloud-'));

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || '/opt/pw-browsers/chromium',
  args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
});

const errors = [];
let failures = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failures++;
};

/** A fresh browser context == a separate person (its own anonymous uid). */
async function newPerson(label) {
  const context = await browser.newContext({ viewport: { width: 700, height: 900 }, permissions: ['camera'], acceptDownloads: true });
  const page = await context.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error' && !m.location().url.includes('favicon.ico')) errors.push(`[${label}] ${m.text()}`);
  });
  page.on('pageerror', (e) => errors.push(`[${label}] pageerror: ${e.message}`));
  await page.goto(APP, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => Boolean(window.__clumsyloopEngine), undefined, { timeout: 15000 });
  return page;
}

const shoot = async (page, n) => {
  for (let i = 0; i < n; i++) {
    await page.getByRole('button', { name: 'Shutter' }).click();
    await page.waitForFunction((k) => window.__clumsyloopEngine.doc.layers.find((l) => l.kind === 'camera')?.cels.size === k, i + 1, { timeout: 10000 });
  }
};
const uidOf = (page) =>
  page.evaluate(async () => {
    const { getCloud } = await import('/src/cloud/firebase.ts');
    return getCloud().auth.currentUser?.uid ?? null;
  });
const rail = (page, name) => page.locator('.cl-rail--top').getByRole('button', { name, exact: true });

// Admin access to the Firestore emulator (what a Cloud Function would have).
const admin = (path, init = {}) => fetch(`${FS}/${path}`, { ...init, headers: { Authorization: 'Bearer owner', 'Content-Type': 'application/json' } });
const adminGet = async (path) => {
  const r = await admin(path);
  return r.ok ? r.json() : null;
};
const str = (doc, k) => doc?.fields?.[k]?.stringValue;
const listClips = async () => ((await (await admin('clips')).json()).documents ?? []);

const ffprobe = (path) =>
  JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,nb_read_frames,r_frame_rate', '-of', 'json', path]).toString()).streams[0];
const firstFrame = (path) => execFileSync('ffmpeg', ['-v', 'error', '-i', path, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1 << 28 });
const cornerDiff = (a, b, w, h) => {
  let n = 0;
  for (let i = 0; i < a.length; i += 3) {
    const d = Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2]));
    const px = i / 3;
    if (d >= 40 && px % w > w * 0.45 && Math.floor(px / w) > h * 0.85) n++;
  }
  return n;
};

console.log('— Alice publishes —');
const alice = await newPerson('alice');
await shoot(alice, 3);
await rail(alice, 'Publish').click();
const dialog = alice.getByRole('dialog', { name: 'Publish clip' });
const covers = (page, sel) =>
  page.evaluate((s) => {
    const r = document.querySelector(s).getBoundingClientRect();
    return r.left === 0 && r.top === 0 && r.width === window.innerWidth && r.height === window.innerHeight;
  }, sel);
check('the publish dialog covers the whole screen, not just the rail it was opened from', await covers(alice, '.cl-modal'));
check('signed out, the dialog asks to sign in', (await dialog.getByText('Sign in to publish.').count()) === 1);
await dialog.getByRole('button', { name: 'Sign in' }).click();
await dialog.getByLabel('Caption (optional)').fill('  a   walk\ncycle ');
await dialog.getByRole('button', { name: 'Publish' }).click();
await dialog.getByText('Published.').waitFor({ timeout: 60000 });
await dialog.getByRole('button', { name: 'Done' }).click();
const aliceUid = await uidOf(alice);
const clips = await listClips();
check('exactly one clip document was created', clips.length === 1, `count=${clips.length}`);
const clipDoc = clips[0];
const clipId = clipDoc.name.split('/').pop();
check('it belongs to Alice, is not hidden, and the caption is normalized', str(clipDoc, 'ownerId') === aliceUid && clipDoc.fields.hidden.booleanValue === false && str(clipDoc, 'caption') === 'a walk cycle', JSON.stringify(clipDoc.fields.caption));
check("its storagePath is Alice's own prefix for this clip", str(clipDoc, 'storagePath') === `clips/${aliceUid}/${clipId}`, str(clipDoc, 'storagePath'));
check('frames/fps metadata match the three shots', clipDoc.fields.frames.integerValue === '3' && clipDoc.fields.fps.integerValue === '12');
const videoPath = join(dir, 'published.mp4');
const videoRes = await fetch(str(clipDoc, 'videoUrl'));
writeFileSync(videoPath, Buffer.from(await videoRes.arrayBuffer()));
const probe = ffprobe(videoPath);
check('the uploaded file is a 3-frame H.264 MP4', probe.codec_name === 'h264' && Number(probe.nb_read_frames) === 3, JSON.stringify(probe));

console.log('\n— Watermark follows the entitlement (free plan → subscriber) —');
const W = await alice.evaluate(() => window.__clumsyloopEngine.doc.width);
const H = await alice.evaluate(() => window.__clumsyloopEngine.doc.height);
const renderRef = async (watermark) => {
  const b64 = await alice.evaluate(async (wm) => {
    const blob = await window.__clumsyloopExportVideo(window.__clumsyloopEngine, { watermark: wm });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }, watermark);
  const p = join(dir, `ref-${watermark}.mp4`);
  writeFileSync(p, Buffer.from(b64, 'base64'));
  return firstFrame(p);
};
const refMarked = await renderRef(true);
const refClean = await renderRef(false);
const exportViaUi = async (name) => {
  const [download] = await Promise.all([alice.waitForEvent('download', { timeout: 60000 }), rail(alice, 'Export video').click()]);
  const p = join(dir, name);
  await download.saveAs(p);
  return firstFrame(p);
};
const freeExport = await exportViaUi('free.mp4');
check('with no entitlement the UI export carries the watermark', cornerDiff(freeExport, refMarked, W, H) === 0 && cornerDiff(freeExport, refClean, W, H) > 200);
await admin(`entitlements/${aliceUid}`, { method: 'PATCH', body: JSON.stringify({ fields: { active: { booleanValue: true }, productId: { stringValue: 'pro_yearly' } } }) });
await alice.waitForTimeout(1500); // the live listener picks the new entitlement up
const proExport = await exportViaUi('pro.mp4');
check('once the entitlement is active the UI export is clean', cornerDiff(proExport, refClean, W, H) === 0 && cornerDiff(proExport, refMarked, W, H) > 200);

console.log('\n— Bob browses, reports, and publishes —');
const bob = await newPerson('bob');
await rail(bob, 'Feed').click();
const feed = bob.getByRole('dialog', { name: 'Feed' });
await feed.locator('.cl-clip').first().waitFor({ timeout: 15000 });
check('the feed covers the whole screen', await covers(bob, '.cl-feed'));
check("signed out, Bob can read the feed and sees Alice's clip with its caption", (await feed.locator('.cl-clip').count()) === 1 && (await feed.getByText('a walk cycle').count()) === 1);
check('the clip plays from a real video element', (await feed.locator('video.cl-clip__video').getAttribute('src')) === str(clipDoc, 'videoUrl'));
check("signed out, there's no Delete — only Report and Block", (await feed.getByRole('button', { name: 'Delete' }).count()) === 0);
await feed.getByRole('button', { name: 'Report' }).click(); // signed out: this signs him in
await bob.waitForFunction(async () => (await import('/src/cloud/firebase.ts')).getCloud().auth.currentUser !== null);
await feed.locator('.cl-clip').first().waitFor();
await feed.getByRole('button', { name: 'Report' }).click();
await feed.getByRole('button', { name: 'Spam' }).click();
await feed.getByText('Reported.').waitFor({ timeout: 10000 });
check('a reported clip leaves the reporter’s feed immediately', (await feed.locator('.cl-clip').count()) === 0);
const bobUid = await uidOf(bob);
const reportDoc = await adminGet(`reports/${clipId}_${bobUid}`);
check('the report document exists with the right reporter, clip, and reason', str(reportDoc, 'reporterId') === bobUid && str(reportDoc, 'clipId') === clipId && str(reportDoc, 'reason') === 'spam');
// Simulates onReportCreated (task 5.2), which can't run in this sandbox's emulators.
await admin(`clips/${clipId}?updateMask.fieldPaths=hidden`, { method: 'PATCH', body: JSON.stringify({ fields: { hidden: { booleanValue: true } } }) });
await feed.getByRole('button', { name: 'Close feed' }).click();
await rail(bob, 'Feed').click();
await bob.getByRole('dialog', { name: 'Feed' }).getByText('Nothing here yet.').waitFor({ timeout: 15000 });
check('once hidden, the clip stays out of the feed after a reload', (await bob.locator('.cl-clip').count()) === 0);
await bob.getByRole('dialog', { name: 'Feed' }).getByRole('button', { name: 'Close feed' }).click();

await shoot(bob, 2);
await rail(bob, 'Publish').click();
const bobDialog = bob.getByRole('dialog', { name: 'Publish clip' });
await bobDialog.getByLabel('Caption (optional)').fill("bob's loop");
await bobDialog.getByRole('button', { name: 'Publish' }).click();
await bobDialog.getByText('Published.').waitFor({ timeout: 60000 });
await bobDialog.getByRole('button', { name: 'Done' }).click();
const bobClip = (await listClips()).find((d) => str(d, 'ownerId') === bobUid);
const bobClipId = bobClip.name.split('/').pop();
check('Bob’s own clip was published', Boolean(bobClip));

console.log('\n— Alice blocks Bob —');
await rail(alice, 'Feed').click();
const aliceFeed = alice.getByRole('dialog', { name: 'Feed' });
await aliceFeed.getByText("bob's loop").waitFor({ timeout: 15000 });
check("Alice's own hidden clip is not in her feed; Bob's is", (await aliceFeed.locator('.cl-clip').count()) === 1);
await aliceFeed.getByRole('button', { name: 'Block author' }).click();
await aliceFeed.getByText('Blocked.').waitFor({ timeout: 10000 });
check("blocking removes the author's clips immediately", (await aliceFeed.locator('.cl-clip').count()) === 0);
check('the block is stored privately under Alice', Boolean(await adminGet(`users/${aliceUid}/blocks/${bobUid}`)));
await aliceFeed.getByRole('button', { name: 'Close feed' }).click();
await rail(alice, 'Feed').click();
await alice.getByRole('dialog', { name: 'Feed' }).getByText('Nothing here yet.').waitFor({ timeout: 15000 });
check("after a reload Bob's clip is still filtered out by the stored block", (await alice.locator('.cl-clip').count()) === 0);
await alice.getByRole('dialog', { name: 'Feed' }).getByRole('button', { name: 'Close feed' }).click();

console.log('\n— Bob deletes his own clip —');
await rail(bob, 'Feed').click();
const bobFeed = bob.getByRole('dialog', { name: 'Feed' });
await bobFeed.getByText("bob's loop").waitFor({ timeout: 15000 });
check('on his own clip Bob gets Delete, not Report/Block', (await bobFeed.getByRole('button', { name: 'Delete' }).count()) === 1 && (await bobFeed.getByRole('button', { name: 'Report' }).count()) === 0);
await bobFeed.getByRole('button', { name: 'Delete' }).click();
await bobFeed.getByText('Nothing here yet.').waitFor({ timeout: 10000 });
check('the clip document is gone', (await adminGet(`clips/${bobClipId}`)) === null);
const gone = await fetch(str(bobClip, 'videoUrl'));
check('and so is its video file', gone.status === 404, `status=${gone.status}`);

console.log('\n— Feed order and paging —');
// Seeded with admin writes so the createdAt values (and so the expected order)
// are known. 14 clips, so two pages (the page size is 12).
const seedAt = (n) => `${2020 + Math.floor(n / 12)}-${String((n % 12) + 1).padStart(2, '0')}-15T12:00:00Z`;
for (let n = 0; n < 14; n++) {
  await admin(`clips/seed-${String(n).padStart(2, '0')}`, {
    method: 'PATCH',
    body: JSON.stringify({
      fields: {
        ownerId: { stringValue: 'seeder' },
        storagePath: { stringValue: `clips/seeder/seed-${n}` },
        videoUrl: { stringValue: 'data:video/mp4;base64,AAAA' }, // no network fetch for fake clips
        caption: { stringValue: `clip ${n}` },
        hidden: { booleanValue: false },
        createdAt: { timestampValue: seedAt(n) },
      },
    }),
  });
}
const reader = await newPerson('reader');
await rail(reader, 'Feed').click();
const readerFeed = reader.getByRole('dialog', { name: 'Feed' });
await readerFeed.locator('.cl-clip').first().waitFor({ timeout: 15000 });
const captions = () => readerFeed.locator('.cl-clip__caption').allTextContents();
const firstPage = await captions();
check('the first page holds 12 clips, newest first', firstPage.length === 12 && firstPage[0] === 'clip 13' && firstPage[11] === 'clip 2', `${firstPage.length}: ${firstPage[0]}…${firstPage[firstPage.length - 1]}`);
await readerFeed.getByRole('button', { name: 'Load more' }).click();
await readerFeed.locator('.cl-clip').nth(13).waitFor({ timeout: 15000 });
const all = await captions();
check('Load more continues in order with no gap or repeat', all.length === 14 && all.every((c, i) => c === `clip ${13 - i}`), all.join(','));
check('once the feed runs out the button goes away', (await readerFeed.getByRole('button', { name: 'Load more' }).count()) === 0);

console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) FAILED.`}`);
if (errors.length > 0) {
  console.log('\nConsole errors observed:');
  for (const e of errors) console.log(' ', e);
}
await browser.close();
process.exit(failures > 0 || errors.length > 0 ? 1 : 0);
