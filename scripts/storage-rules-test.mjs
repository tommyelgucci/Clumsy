import { readFileSync } from 'node:fs';
import { initializeTestEnvironment, assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { ref, uploadBytes, getBytes, deleteObject } from 'firebase/storage';

// Verifies storage.rules (task 4.1's schema half) against the local
// Storage emulator — same reasoning and same emulator-only approach as
// scripts/firestore-rules-test.mjs. Run via `firebase emulators:exec
// --only storage 'npm run test:storage-rules'` so the emulator is
// already up by the time this connects.

let failures = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failures++;
};

const expectAllowed = async (name, pr) => {
  try {
    await assertSucceeds(pr);
    check(name, true);
  } catch (e) {
    check(name, false, e instanceof Error ? e.message : String(e));
  }
};

const expectDenied = async (name, pr) => {
  try {
    await assertFails(pr);
    check(name, true);
  } catch (e) {
    check(name, false, e instanceof Error ? e.message : String(e));
  }
};

const testEnv = await initializeTestEnvironment({
  projectId: 'demo-clumsyloop',
  storage: {
    rules: readFileSync('storage.rules', 'utf8'),
    host: '127.0.0.1',
    port: 9199,
  },
});

const alice = testEnv.authenticatedContext('alice');
const bob = testEnv.authenticatedContext('bob');
const anon = testEnv.unauthenticatedContext();

const fakeVideo = new Uint8Array([1, 2, 3, 4]);

console.log('— clips/{ownerId}/{clipId}: owner-only write/delete, public read —');
await expectAllowed('the owner can upload under their own prefix', uploadBytes(ref(alice.storage(), 'clips/alice/clip-1'), fakeVideo));
await expectDenied('a different user cannot upload under alice’s prefix', uploadBytes(ref(bob.storage(), 'clips/alice/clip-2'), fakeVideo));
await expectDenied('an unauthenticated client cannot upload at all', uploadBytes(ref(anon.storage(), 'clips/alice/clip-3'), fakeVideo));
await expectAllowed('anyone (even unauthenticated) can read a published clip', getBytes(ref(anon.storage(), 'clips/alice/clip-1')));
await expectDenied('a different user cannot delete alice’s clip', deleteObject(ref(bob.storage(), 'clips/alice/clip-1')));
await expectAllowed('the owner can delete their own clip', deleteObject(ref(alice.storage(), 'clips/alice/clip-1')));

await testEnv.cleanup();

console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) failed.`}`);
process.exit(failures === 0 ? 0 : 1);
