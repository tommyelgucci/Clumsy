import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { onDocumentCreated } from 'firebase-functions/v2/firestore';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { shouldHideClip } from './moderation.js';
import { ReceiptRejected, validateReceipt } from './validateReceipt.js';

initializeApp();

/** Clumsyloop's own bundle ID — a real registered value would replace
 *  this once the iOS app is actually registered in App Store Connect
 *  (task 3.1's territory); a `validateReceipt` call against a real
 *  transaction for a different app's bundle ID must still be rejected,
 *  so this constant exists even before that's settled. */
const BUNDLE_ID = 'com.clumsyloop.app';

function mustGetEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new HttpsError('internal', `Missing required config: ${name}`);
  return value;
}

/**
 * Firestore trigger (task 5.2): a new `reports/{reportId}` document
 * counts how many reports now exist for that report's `clipId`, and
 * hides the clip (`clips/{clipId}.hidden = true`) once `shouldHideClip`
 * (see moderation.ts) says the threshold is crossed. Runs with Admin SDK
 * privileges, which is what actually lets it write `hidden` at all —
 * firestore.rules refuses that field to every client, by design (see
 * that file's own comment on `clips`).
 *
 * A no-op, not an error, on a malformed report (missing/non-string
 * `clipId`) — firestore.rules' own `reports.create` rule already
 * requires a real `reporterId`, but says nothing about `clipId`'s shape,
 * so this stays defensive rather than assuming the client always sends
 * a well-formed document.
 */
export const onReportCreated = onDocumentCreated('reports/{reportId}', async (event) => {
  const report = event.data?.data();
  const clipId = report?.clipId;
  if (typeof clipId !== 'string' || clipId.length === 0) return;

  const db = getFirestore();
  const reports = await db.collection('reports').where('clipId', '==', clipId).get();
  if (!shouldHideClip(reports.size)) return;

  await db.doc(`clips/${clipId}`).set({ hidden: true }, { merge: true });
});

/**
 * Callable Cloud Function (task 3.4): the client sends a StoreKit 2
 * transaction ID, never trusted alone (CLAUDE.md) — this fetches and
 * validates it against Apple's App Store Server API (validateReceipt.ts
 * has the actual decision logic; this is the thin runtime wrapper,
 * same shape as `onReportCreated` above) and only then writes the
 * entitlement, with Admin SDK privileges firestore.rules' own
 * `entitlements` rule refuses to every client.
 *
 * `APP_STORE_KEY_ID`/`APP_STORE_ISSUER_ID`/`APP_STORE_PRIVATE_KEY` are
 * real App Store Connect API credentials this project doesn't have yet
 * — they'd arrive via `firebase functions:secrets:set` at deploy time,
 * never committed. `APP_STORE_ENVIRONMENT=sandbox` targets Apple's
 * sandbox endpoint for testing real purchases before this ships.
 *
 * See transactionPayload.ts's own header comment for the one real gap
 * still open here: the JWS payload from Apple is decoded but not yet
 * signature-verified against Apple's certificate chain, so this isn't
 * safe to accept real payments with yet, even though every other piece
 * (auth, the HTTP call, parsing, the entitlement decision, and rejecting
 * without writing anything on failure) is built and tested.
 */
export const validateReceiptCallable = onCall<{ transactionId: unknown }>(async (request) => {
  const { transactionId } = request.data;
  if (typeof transactionId !== 'string' || transactionId.length === 0) {
    throw new HttpsError('invalid-argument', 'transactionId is required');
  }
  const uid = request.auth?.uid;
  if (!uid) {
    throw new HttpsError('unauthenticated', 'Sign in required');
  }

  const config = {
    keyId: mustGetEnv('APP_STORE_KEY_ID'),
    issuerId: mustGetEnv('APP_STORE_ISSUER_ID'),
    bundleId: BUNDLE_ID,
    privateKeyPem: mustGetEnv('APP_STORE_PRIVATE_KEY'),
    sandbox: process.env.APP_STORE_ENVIRONMENT === 'sandbox',
  };

  let update;
  try {
    update = await validateReceipt(transactionId, BUNDLE_ID, config);
  } catch (err) {
    if (err instanceof ReceiptRejected) throw new HttpsError('failed-precondition', err.message);
    throw err;
  }

  await getFirestore().doc(`entitlements/${uid}`).set(update, { merge: true });
  return update;
});
