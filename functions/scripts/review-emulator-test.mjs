import { initializeApp } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import { listReportedClipsHandler, reviewClipHandler } from '../src/reviewHandlers.ts';

// Runs the review handlers (task 5.3) against the REAL Firestore and Storage
// emulators — everything except the thin `onCall` wrapper in index.ts, which
// only forwards `request.auth.uid`/`request.data`. Run via
//   firebase emulators:exec --only firestore,storage --project demo-clumsyloop \
//     'npm --prefix functions run test:emulator'

initializeApp({ projectId: 'demo-clumsyloop', storageBucket: 'demo-clumsyloop.appspot.com' });
const db = getFirestore();
// Start from an empty database: other emulator suites (the rules tests) leave
// clips and reports behind, which would show up in the queue.
await fetch(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/demo-clumsyloop/databases/(default)/documents`, { method: 'DELETE' });
const bucket = getStorage().bucket();
const deps = { db, bucket };

let failures = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failures++;
};
const code = async (pr) => {
  try {
    await pr;
    return 'ok';
  } catch (e) {
    return e?.code ?? String(e);
  }
};
const exists = async (path) => (await bucket.file(path).exists())[0];
const at = (iso) => Timestamp.fromDate(new Date(iso));

const seedClip = async (id, ownerId, over = {}) => {
  const storagePath = over.storagePath ?? `clips/${ownerId}/${id}`;
  await db.doc(`clips/${id}`).set({ ownerId, storagePath, videoUrl: `https://example.invalid/${id}`, caption: id, hidden: true, createdAt: at('2020-01-01'), ...over });
  return storagePath;
};
const seedReport = (clipId, reporterId, iso, reason = 'spam') =>
  db.doc(`reports/${clipId}_${reporterId}`).set({ clipId, reporterId, reason, createdAt: at(iso) });
const putFile = (path) => bucket.file(path).save(Buffer.from('video'), { contentType: 'video/mp4' });
const reportsFor = async (clipId) => (await db.collection('reports').where('clipId', '==', clipId).get()).size;

await db.doc('admins/root').set({});

console.log('— Only admins get in —');
check('listing with no sign-in is unauthenticated', (await code(listReportedClipsHandler(deps, undefined))) === 'unauthenticated');
check('listing as a non-admin is permission-denied', (await code(listReportedClipsHandler(deps, 'mallory'))) === 'permission-denied');
check('reviewing as a non-admin is permission-denied', (await code(reviewClipHandler(deps, 'mallory', { clipId: 'x', decision: 'delete' }))) === 'permission-denied');
check('reviewing with no sign-in is unauthenticated', (await code(reviewClipHandler(deps, undefined, { clipId: 'x', decision: 'delete' }))) === 'unauthenticated');
check('a missing admin document means no access even for a real uid', (await code(listReportedClipsHandler(deps, 'bob'))) === 'permission-denied');

console.log('\n— The queue —');
const oldPath = await seedClip('c-old', 'alice');
await putFile(oldPath);
await seedReport('c-old', 'r1', '2026-10-01T10:00:00Z', 'harassment');
await seedReport('c-old', 'r2', '2026-10-01T09:00:00Z', 'spam');
await seedClip('c-new', 'carol');
await seedReport('c-new', 'r1', '2026-10-02T10:00:00Z');
await seedReport('c-orphan', 'r1', '2026-09-01T10:00:00Z'); // its clip was deleted by the owner
const { queue } = await listReportedClipsHandler(deps, 'root');
check('reported clips are listed, oldest report first, orphans dropped', queue.map((q) => q.id).join() === 'c-old,c-new', queue.map((q) => q.id).join());
check("a clip's reports are listed oldest first with their reasons", queue[0].reports.map((r) => r.reason).join() === 'spam,harassment');
check('the deadline is 24h after the OLDEST report', queue[0].dueAtMs === Date.parse('2026-10-01T09:00:00Z') + 24 * 3600 * 1000);
check('the clip details the panel needs come through', queue[0].ownerId === 'alice' && queue[0].caption === 'c-old' && queue[0].hidden === true && queue[0].videoUrl.endsWith('c-old'));

console.log('\n— Bad requests —');
check('an unknown decision is invalid-argument', (await code(reviewClipHandler(deps, 'root', { clipId: 'c-new', decision: 'ban' }))) === 'invalid-argument');
check('a path-like clip id is invalid-argument', (await code(reviewClipHandler(deps, 'root', { clipId: '../admins/root', decision: 'delete' }))) === 'invalid-argument');
check('a bad request touched nothing', (await db.doc('clips/c-new').get()).exists && (await reportsFor('c-new')) === 1);

console.log('\n— Restore —');
const restored = await reviewClipHandler(deps, 'root', { clipId: 'c-new', decision: 'restore' });
check('the clip is shown again', restored.status === 'restored' && (await db.doc('clips/c-new').get()).get('hidden') === false);
check('its reports are cleared so it leaves the queue', (await reportsFor('c-new')) === 0 && (await listReportedClipsHandler(deps, 'root')).queue.every((q) => q.id !== 'c-new'));

console.log('\n— Delete —');
check('the file exists before the decision', await exists(oldPath));
const deleted = await reviewClipHandler(deps, 'root', { clipId: 'c-old', decision: 'delete' });
check('the video file is gone from Storage', deleted.status === 'deleted' && deleted.fileDeleted && !(await exists(oldPath)));
check('the clip document and all its reports are gone', !(await db.doc('clips/c-old').get()).exists && (await reportsFor('c-old')) === 0);

console.log('\n— A tampered storagePath never deletes someone else’s file —');
await putFile('clips/bob/victim');
await seedClip('c-evil', 'alice', { storagePath: 'clips/bob/victim' });
await seedReport('c-evil', 'r1', '2026-10-03T10:00:00Z');
const evil = await reviewClipHandler(deps, 'root', { clipId: 'c-evil', decision: 'delete' });
check("the clip is deleted but the other user's file is untouched", evil.status === 'deleted' && !evil.fileDeleted && (await exists('clips/bob/victim')) && !(await db.doc('clips/c-evil').get()).exists);

console.log('\n— Already removed by its owner —');
const gone = await reviewClipHandler(deps, 'root', { clipId: 'c-orphan', decision: 'delete' });
check('stale reports are cleared', gone.status === 'already-gone' && (await reportsFor('c-orphan')) === 0);
check('deciding the same clip twice is harmless', (await reviewClipHandler(deps, 'root', { clipId: 'c-old', decision: 'delete' })).status === 'already-gone');

console.log('\n— Audit trail —');
const log = (await db.collection('moderationLog').get()).docs.map((d) => d.data());
const entry = (clipId) => log.find((e) => e.clipId === clipId && e.outcome !== 'already-gone');
check('every decision is logged with who made it', log.length === 5 && log.every((e) => e.adminUid === 'root' && e.at));
check('the log keeps the reasons and report count', entry('c-old').reportCount === 2 && entry('c-old').reasons.sort().join() === 'harassment,spam' && entry('c-old').outcome === 'deleted' && entry('c-old').ownerId === 'alice');
check('restore and delete are told apart', entry('c-new').outcome === 'restored' && entry('c-new').decision === 'restore');
check('the failed requests left no log entries', !log.some((e) => e.decision === 'ban'));

console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) FAILED.`}`);
process.exit(failures === 0 ? 0 : 1);
