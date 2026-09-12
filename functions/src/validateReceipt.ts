import type { AppStoreClientConfig, FetchLike } from './appStoreClient.js';
import { fetchTransactionInfo } from './appStoreClient.js';
import { decideEntitlement, type EntitlementUpdate } from './entitlement.js';
import { decodeJwsPayload, parseTransactionInfo } from './transactionPayload.js';

export class ReceiptRejected extends Error {}

/**
 * The actual decision behind the `validateReceipt` callable (task 3.4),
 * pulled out of `index.ts`'s Cloud Function wrapper so it's directly
 * unit-testable — same "thin runtime wrapper around plain, testable
 * logic" shape `onReportCreated`/`moderation.ts` already use (task 5.2).
 * Fetches the transaction from Apple, decodes (NOT signature-verifies —
 * see transactionPayload.ts) its payload, confirms it's for this app,
 * and decides the entitlement. Throws `ReceiptRejected` for every
 * failure mode — Apple itself refusing the transaction ID, a malformed
 * payload, or a payload for a different app's bundle ID — so the caller
 * (`index.ts`) has exactly one thing to catch and turn into an
 * `HttpsError`, and writes nothing to Firestore in any of those cases.
 */
export async function validateReceipt(
  transactionId: string,
  bundleId: string,
  config: AppStoreClientConfig,
  fetchImpl?: FetchLike,
): Promise<EntitlementUpdate> {
  let jws: string;
  try {
    jws = await fetchTransactionInfo(transactionId, config, fetchImpl);
  } catch (err) {
    throw new ReceiptRejected(`Could not verify this transaction with Apple: ${err instanceof Error ? err.message : String(err)}`);
  }

  const payload = decodeJwsPayload(jws);
  const info = parseTransactionInfo(payload);
  if (!info) {
    throw new ReceiptRejected('Transaction payload was malformed');
  }
  if (info.bundleId !== bundleId) {
    throw new ReceiptRejected('Transaction payload was for a different app');
  }

  return decideEntitlement(info, Date.now());
}
