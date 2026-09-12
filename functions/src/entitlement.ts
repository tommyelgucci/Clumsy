import type { TransactionInfo } from './transactionPayload.js';

/**
 * Entitlement decision (task 3.4/3.5) — pure, given an already-parsed
 * `TransactionInfo` (see transactionPayload.ts for what "already-parsed"
 * does and doesn't guarantee about the payload's authenticity). A
 * revoked or expired transaction still produces an update, just an
 * inactive one — the client's entitlement should correctly flip back off
 * when a subscription lapses or Apple refunds it, not disappear/freeze.
 * `null` is reserved for "no legitimate decision can be made at all"
 * (currently unused, since a well-formed `TransactionInfo` always
 * produces one of the two outcomes below — kept as the return type
 * `index.ts` already expects for "reject without writing anything" on a
 * shape it couldn't parse in the first place).
 */
export interface EntitlementUpdate {
  active: boolean;
  productId: string;
}

export function decideEntitlement(info: TransactionInfo, now: number): EntitlementUpdate {
  const revoked = info.revocationDate !== null && info.revocationDate <= now;
  const expired = info.expiresDate !== null && info.expiresDate <= now;
  return { active: !revoked && !expired, productId: info.productId };
}
