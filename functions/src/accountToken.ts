import { createHash } from 'node:crypto';

/**
 * Binds a StoreKit 2 transaction to the Firebase user who's supposed to
 * own it (task 3.4's other real gap, alongside the missing secret
 * bindings — both caught by a Codex review, neither by this project's
 * own tests, since both only bite a real deployment/real purchase).
 * Without this, `validateReceiptCallable` trusted whatever
 * `request.auth.uid` the CALLER happened to be signed in as: any
 * authenticated user who obtained someone else's real `transactionId`
 * (not a secret — it can appear in client logs, screenshots, support
 * tickets) could call the function themselves and have the resulting
 * entitlement written to THEIR OWN uid instead of the actual purchaser.
 *
 * StoreKit 2 gives every transaction an `appAccountToken: UUID?` field
 * the client sets at purchase time and Apple echoes back unmodified in
 * every subsequent transaction/renewal — the intended mechanism for
 * exactly this binding. A Firebase `uid` isn't itself a valid UUID
 * (`Transaction.appAccountToken` requires Swift's `UUID` type), so
 * instead of inventing a separate mapping collection to remember which
 * random UUID belongs to which uid, this derives a UUID deterministically
 * from the uid via UUIDv5 (RFC 4122) — the same input always produces
 * the same UUID, with no storage needed on either side. The client half
 * of this binding (setting `Transaction.appAccountToken` to this exact
 * derivation before finishing a purchase) is task 3.3's job, still
 * pending — this function is what task 3.3's Swift code will eventually
 * need to reproduce bit-for-bit; until then, `validateReceiptCallable`
 * simply rejects every transaction, since a real purchase's Apple-signed
 * payload will never carry a token nobody has set yet. `ACCOUNT_TOKEN_
 * NAMESPACE` must never change once any client has started setting
 * tokens against it — changing it would silently invalidate every
 * previously-bound transaction.
 */
const ACCOUNT_TOKEN_NAMESPACE = '6e6f0f4a-9b7f-5b1e-8c2b-2f7e6c1a9d3e';

function uuidBytes(uuid: string): Buffer {
  return Buffer.from(uuid.replace(/-/g, ''), 'hex');
}

/** UUIDv5(name, namespace) per RFC 4122 §4.3 — SHA-1 of the namespace's
 *  raw bytes followed by the name's UTF-8 bytes, then the version/variant
 *  bits forced into the hash's first 16 bytes. */
export function deriveAppAccountToken(uid: string): string {
  const hash = createHash('sha1')
    .update(uuidBytes(ACCOUNT_TOKEN_NAMESPACE))
    .update(Buffer.from(uid, 'utf8'))
    .digest();
  const bytes = hash.subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
