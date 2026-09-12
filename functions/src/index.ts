import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { onDocumentCreated } from 'firebase-functions/v2/firestore';
import { shouldHideClip } from './moderation.js';

initializeApp();

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
