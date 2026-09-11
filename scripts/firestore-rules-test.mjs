import { readFileSync } from 'node:fs';
import { initializeTestEnvironment, assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { doc, getDoc, setDoc, updateDoc, deleteDoc } from 'firebase/firestore';

// Verifies firestore.rules (task 3.2) against the local Firestore
// emulator — no real Firebase project needed, since `.firebaserc`'s
// "demo-clumsyloop" project ID is the documented way to run the emulator
// suite standalone. Run via `firebase emulators:exec --only firestore
// 'npm run test:rules'` (see package.json and tasks.json's task 3.2) so
// the emulator is already up by the time this connects.

let failures = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failures++;
};

/** Runs `pr`, expecting the rules to allow it. */
const expectAllowed = async (name, pr) => {
  try {
    await assertSucceeds(pr);
    check(name, true);
  } catch (e) {
    check(name, false, e instanceof Error ? e.message : String(e));
  }
};

/** Runs `pr`, expecting the rules to deny it with permission-denied. */
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
  firestore: {
    rules: readFileSync('firestore.rules', 'utf8'),
    host: '127.0.0.1',
    port: 8080,
  },
});

await testEnv.clearFirestore();

// Seed data a client could never write on its own (an existing project
// owned by Alice, an existing entitlement for Alice) with rules bypassed
// — the same access an Admin-SDK Cloud Function would have.
await testEnv.withSecurityRulesDisabled(async (context) => {
  const db = context.firestore();
  await setDoc(doc(db, 'projects/alice-project'), { ownerId: 'alice', name: 'Alice clip' });
  await setDoc(doc(db, 'entitlements/alice'), { active: true, productId: 'pro_yearly' });
  await setDoc(doc(db, 'users/alice'), { displayName: 'Alice' });
});

const alice = testEnv.authenticatedContext('alice');
const bob = testEnv.authenticatedContext('bob');
const anon = testEnv.unauthenticatedContext();

console.log('\n— users/{userId}: publicly readable, only the owner can write —');
await expectAllowed('anyone (even unauthenticated) can read a user profile', getDoc(doc(anon.firestore(), 'users/alice')));
await expectAllowed('a user can write their own profile', setDoc(doc(alice.firestore(), 'users/alice'), { displayName: 'Alice A.' }));
await expectDenied("a different user cannot write alice's profile", setDoc(doc(bob.firestore(), 'users/alice'), { displayName: 'Not Alice' }));
await expectDenied('an unauthenticated client cannot create a user profile', setDoc(doc(anon.firestore(), 'users/carol'), { displayName: 'Carol' }));

console.log('\n— projects/{projectId}: only the owner can read, write, or delete —');
await expectAllowed('a user can create a project with themselves as owner', setDoc(doc(alice.firestore(), 'projects/second-alice-project'), { ownerId: 'alice', name: 'Second clip' }));
await expectDenied('a user cannot create a project owned by someone else', setDoc(doc(bob.firestore(), 'projects/spoofed-project'), { ownerId: 'alice', name: 'Spoofed' }));
await expectAllowed('the owner can read their own project', getDoc(doc(alice.firestore(), 'projects/alice-project')));
await expectDenied("a different user cannot read alice's project", getDoc(doc(bob.firestore(), 'projects/alice-project')));
await expectAllowed('the owner can update their own project', updateDoc(doc(alice.firestore(), 'projects/alice-project'), { name: 'Renamed clip' }));
await expectDenied("a different user cannot update alice's project", updateDoc(doc(bob.firestore(), 'projects/alice-project'), { name: 'Hijacked' }));
await expectDenied("a different user cannot delete alice's project", deleteDoc(doc(bob.firestore(), 'projects/alice-project')));
await expectAllowed('the owner can delete their own project', deleteDoc(doc(alice.firestore(), 'projects/alice-project')));

console.log('\n— entitlements/{userId}: read your own, write none (Cloud Function only) —');
await expectAllowed('the owner can read their own entitlement', getDoc(doc(alice.firestore(), 'entitlements/alice')));
await expectDenied("a different user cannot read alice's entitlement", getDoc(doc(bob.firestore(), 'entitlements/alice')));
await expectDenied('the owner cannot write their own entitlement — only a Cloud Function can', setDoc(doc(alice.firestore(), 'entitlements/alice'), { active: true, productId: 'free_forever' }));
await expectDenied('an unauthenticated client cannot create an entitlement', setDoc(doc(anon.firestore(), 'entitlements/carol'), { active: true }));

await testEnv.cleanup();

console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) failed.`}`);
process.exit(failures === 0 ? 0 : 1);
