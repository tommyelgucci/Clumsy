import { chromium } from 'playwright';

// End-to-end check of the internal review panel (task 5.3) against the local
// Auth/Firestore/Storage/FUNCTIONS emulators: the real `onReportCreated`
// trigger hides reported clips, the real `listReportedClips`/`reviewClip`
// callables serve the panel, and the panel is driven through its UI.
//
//   npm --prefix functions run build
//   VITE_USE_FIREBASE_EMULATORS=true npx vite --config admin/vite.config.ts --port 5175 &
//   env -u HTTPS_PROXY -u https_proxy -u GLOBAL_AGENT_HTTPS_PROXY ... \
//     firebase emulators:exec --only auth,firestore,storage,functions \
//     --project demo-clumsyloop 'npm run test:admin-smoke'
//
// The proxy variables must be unset for the firebase CLI in this sandbox:
// otherwise it routes its own 127.0.0.1 call (registering the Firestore
// trigger) through the egress proxy, which refuses it.

const APP = process.env.ADMIN_URL || 'http://127.0.0.1:5175/';
const FS = 'http://127.0.0.1:8080/v1/projects/demo-clumsyloop/databases/(default)/documents';
const BUCKET = 'demo-clumsyloop.appspot.com';
const H = 3_600_000;

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/opt/pw-browsers/chromium', args: ['--enable-unsafe-swiftshader'] });
const errors = [];
// A refused callable answers HTTP 403, which the browser logs as a failed
// resource load. Those are expected (and counted, so an unexpected one still
// shows up) rather than lumped in with real console errors.
let refused403 = 0;
let failures = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failures++;
};

const admin = (path, init = {}) => fetch(`${FS}/${path}`, { ...init, headers: { Authorization: 'Bearer owner', 'Content-Type': 'application/json' } });
const getDoc = async (path) => {
  const r = await admin(path);
  return r.ok ? r.json() : null;
};
const put = (path, fields) => admin(path, { method: 'PATCH', body: JSON.stringify({ fields }) });
const ts = (ms) => ({ timestampValue: new Date(ms).toISOString() });
const s = (v) => ({ stringValue: v });
const objectStatus = async (name) => (await fetch(`http://127.0.0.1:9199/v0/b/${BUCKET}/o/${encodeURIComponent(name)}?alt=media`)).status;
const upload = (name) =>
  fetch(`http://127.0.0.1:9199/upload/storage/v1/b/${BUCKET}/o?uploadType=media&name=${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: { Authorization: 'Bearer owner', 'Content-Type': 'video/mp4' },
    body: Buffer.from('not really a video'),
  });

async function newPerson(label) {
  const context = await browser.newContext({ viewport: { width: 900, height: 900 } });
  const page = await context.newPage();
  page.on('console', (m) => {
    if (m.type() !== 'error' || m.location().url.includes('favicon.ico')) return;
    if (m.text().includes('status of 403')) refused403++;
    else errors.push(`[${label}] ${m.text()}`);
  });
  page.on('pageerror', (e) => errors.push(`[${label}] pageerror: ${e.message}`));
  await page.goto(APP, { waitUntil: 'networkidle' });
  return page;
}

console.log('— Signing in without being an admin —');
const page = await newPerson('moderator');
await page.getByRole('button', { name: 'Sign in' }).click();
const uid = (await page.locator('.uid').textContent()).trim();
await page.getByRole('alert').filter({ hasText: 'not on the admin list' }).waitFor({ timeout: 15000 });
check('a signed-in non-admin is told the account is not on the admin list', true);
check('and is shown exactly which document to create', (await page.getByRole('alert').locator('code').textContent()) === `admins/${uid}`);
check('no clip is shown to them', (await page.locator('.clip').count()) === 0);

console.log('\n— Reports hide clips through the real trigger —');
const now = Date.now();
const seed = async (id, ownerId, reports) => {
  await put(`clips/${id}`, { ownerId: s(ownerId), storagePath: s(`clips/${ownerId}/${id}`), videoUrl: s(`data:video/mp4;base64,AAAA`), caption: s(`caption ${id}`), hidden: { booleanValue: false }, createdAt: ts(now - 50 * H) });
  for (const [reporter, ageH, reason] of reports) {
    await put(`reports/${id}_${reporter}`, { reporterId: s(reporter), clipId: s(id), reason: s(reason), createdAt: ts(now - ageH * H) });
  }
};
await upload('clips/owner1/clip-b');
await seed('clip-a', 'owner1', [['r1', 25, 'harassment'], ['r2', 24.5, 'harassment'], ['r3', 1, 'spam']]); // overdue
await seed('clip-b', 'owner1', [['r1', 21, 'spam']]); // due in ~3h
await seed('clip-c', 'owner2', [['r1', 0.1, 'other']]); // plenty of time
let hidden = 0;
for (let i = 0; i < 40 && hidden < 3; i++) {
  await new Promise((r) => setTimeout(r, 500));
  hidden = (await Promise.all(['clip-a', 'clip-b', 'clip-c'].map((id) => getDoc(`clips/${id}`)))).filter((d) => d?.fields?.hidden?.booleanValue === true).length;
}
check('onReportCreated hid all three reported clips', hidden === 3, `hidden=${hidden}`);

console.log('\n— Becoming an admin —');
await put(`admins/${uid}`, {});
await page.getByRole('button', { name: 'Refresh' }).click();
await page.locator('.clip').first().waitFor({ timeout: 15000 });
const order = await page.locator('.clip').evaluateAll((els) => els.map((e) => e.dataset.clipId));
check('the queue lists the most urgent clip first', order.join() === 'clip-a,clip-b,clip-c', order.join());
const classes = await page.locator('.clip').evaluateAll((els) => els.map((e) => e.className.replace('clip ', '')));
check('urgency is shown: overdue, then soon, then ok', classes.join() === 'overdue,soon,ok', classes.join());
check('an overdue clip says by how long', /OVERDUE by 1h/.test(await page.locator('.clip').first().locator('.due').textContent()));
check('the reasons are tallied', (await page.locator('.clip').first().getByText('harassment ×2, spam').count()) === 1);
check('each clip shows its owner and that it is hidden', (await page.locator('.clip').first().textContent()).includes('owner owner1') && (await page.locator('.clip').first().textContent()).includes('hidden'));
check('each clip has a video player', (await page.locator('.clip video').count()) === 3);

console.log('\n— Restore —');
await page.locator('[data-clip-id="clip-c"]').getByRole('button', { name: 'Restore' }).click();
await page.getByRole('status').filter({ hasText: 'clip-c: restored' }).waitFor({ timeout: 10000 });
check('the restored clip leaves the queue', (await page.locator('.clip').count()) === 2);
check('it is visible again and its reports are gone', (await getDoc('clips/clip-c')).fields.hidden.booleanValue === false && (await getDoc('reports/clip-c_r1')) === null);

console.log('\n— Delete needs a confirmation —');
const clipB = page.locator('[data-clip-id="clip-b"]');
await clipB.getByRole('button', { name: 'Delete…' }).click();
check('the first click only asks to confirm; nothing is deleted yet', (await getDoc('clips/clip-b')) !== null && (await objectStatus('clips/owner1/clip-b')) === 200);
await clipB.getByRole('button', { name: 'Cancel' }).click();
check('cancelling backs out', (await clipB.getByRole('button', { name: 'Delete…' }).count()) === 1 && (await getDoc('clips/clip-b')) !== null);
await clipB.getByRole('button', { name: 'Delete…' }).click();
await clipB.getByRole('button', { name: 'Confirm: delete permanently' }).click();
await page.getByRole('status').filter({ hasText: 'clip-b: deleted permanently.' }).waitFor({ timeout: 10000 });
check('the clip leaves the queue', (await page.locator('.clip').count()) === 1);
check('its document and reports are gone', (await getDoc('clips/clip-b')) === null && (await getDoc('reports/clip-b_r1')) === null);
check('its video file is gone from Storage', (await objectStatus('clips/owner1/clip-b')) === 404);

console.log('\n— Audit trail —');
const log = ((await (await admin('moderationLog')).json()).documents ?? []).map((d) => d.fields);
check('both decisions are logged against this admin', log.length === 2 && log.every((e) => e.adminUid.stringValue === uid));
check('the log says what was decided', log.map((e) => e.outcome.stringValue).sort().join() === 'deleted,restored');

console.log('\n— Someone else cannot use it —');
const other = await newPerson('intruder');
await other.getByRole('button', { name: 'Sign in' }).click();
await other.getByRole('alert').filter({ hasText: 'not on the admin list' }).waitFor({ timeout: 15000 });
check('a second account that is not on the list is refused', (await other.locator('.clip').count()) === 0);
const sneaky = await other.evaluate(async () => {
  const { decide } = await import('/src/api.ts');
  try {
    await decide('clip-a', 'delete');
    return 'allowed';
  } catch (e) {
    return e.code;
  }
});
check('and calling reviewClip directly is refused too', sneaky === 'functions/permission-denied', sneaky);
check('so the overdue clip is still there', (await getDoc('clips/clip-a')) !== null);

check('the only 403s were the three refusals above (two listings, one direct call)', refused403 === 3, `403s=${refused403}`);

console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) FAILED.`}`);
if (errors.length > 0) {
  console.log('\nConsole errors observed:');
  for (const e of errors) console.log(' ', e);
}
await browser.close();
process.exit(failures > 0 || errors.length > 0 ? 1 : 0);
