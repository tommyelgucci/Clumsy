/**
 * Decoding a StoreKit 2 signed transaction (task 3.4). Apple's App Store
 * Server API returns `signedTransactionInfo`: itself a JWS (JSON Web
 * Signature) whose payload is the actual transaction fields, signed by
 * an Apple certificate named in the JWS header's `x5c` chain.
 *
 * `decodeJwsPayload` here only base64url-decodes the payload segment —
 * it does NOT verify the signature against Apple's certificate chain.
 * That's a real, deliberate gap, not an oversight: verifying an X.509
 * chain up to Apple's actual root CA is a meaningful piece of security-
 * critical crypto to get right, and there's no way to test it against a
 * genuine Apple-signed payload from this environment (no real App Store
 * Connect credentials, no network path to Apple's servers here either).
 * Until that verification is added, `index.ts`'s `validateReceipt`
 * function trusts whatever payload is embedded in the JWS it receives —
 * fine for exercising the entitlement-decision logic end to end with a
 * fake payload, NOT safe to accept real purchases with. See CLAUDE.md:
 * "never trust the client" applies just as much to an unverified
 * "server-shaped" response as to a raw client-submitted transaction ID.
 */
export interface TransactionInfo {
  transactionId: string;
  productId: string;
  bundleId: string;
  /** Epoch milliseconds, or `null` for a non-expiring (lifetime)
   *  product. */
  expiresDate: number | null;
  /** Epoch milliseconds if Apple refunded/revoked this transaction,
   *  otherwise `null`. */
  revocationDate: number | null;
  environment: 'Sandbox' | 'Production';
}

function base64urlDecode(segment: string): Buffer {
  const padded = segment.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(padded, 'base64');
}

/** The JWS payload segment, parsed as JSON — see the file header for
 *  what this deliberately does not do (verify the signature). Returns
 *  `null` for anything that isn't a well-formed three-part JWS with a
 *  JSON payload, rather than throwing — a malformed/tampered token is an
 *  expected input this function has to handle, not an exceptional one. */
export function decodeJwsPayload(jws: string): unknown {
  const parts = jws.split('.');
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(base64urlDecode(parts[1]).toString('utf8'));
  } catch {
    return null;
  }
}

/** Validates the decoded payload has the shape `TransactionInfo` needs,
 *  narrowing from Apple's actual (much larger) `JWSTransactionDecoded
 *  Payload` schema to only the fields the entitlement decision (task
 *  3.4/3.5) cares about. Returns `null` on anything missing or the
 *  wrong type — same "expected input, not an exception" reasoning as
 *  `decodeJwsPayload`. */
export function parseTransactionInfo(payload: unknown): TransactionInfo | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const p = payload as Record<string, unknown>;

  if (typeof p.transactionId !== 'string' || typeof p.productId !== 'string' || typeof p.bundleId !== 'string') return null;
  if (p.environment !== 'Sandbox' && p.environment !== 'Production') return null;

  const expiresDate = p.expiresDate === undefined || p.expiresDate === null ? null : Number(p.expiresDate);
  if (expiresDate !== null && !Number.isFinite(expiresDate)) return null;

  const revocationDate = p.revocationDate === undefined || p.revocationDate === null ? null : Number(p.revocationDate);
  if (revocationDate !== null && !Number.isFinite(revocationDate)) return null;

  return {
    transactionId: p.transactionId,
    productId: p.productId,
    bundleId: p.bundleId,
    expiresDate,
    revocationDate,
    environment: p.environment,
  };
}
