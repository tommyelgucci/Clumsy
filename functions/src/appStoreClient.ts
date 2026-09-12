import { signAppStoreJwt, type AppStoreAuthConfig } from './appStoreAuth.js';

const PRODUCTION_BASE = 'https://api.storekit.itunes.apple.com';
const SANDBOX_BASE = 'https://api.storekit-sandbox.itunes.apple.com';

export interface AppStoreClientConfig extends AppStoreAuthConfig {
  sandbox?: boolean;
}

export type FetchLike = typeof fetch;

/**
 * Fetches a transaction's signed info from Apple's App Store Server API
 * (task 3.4). Returns the raw JWS string (`signedTransactionInfo`) —
 * this function's only job is the HTTP round trip and auth, not
 * interpreting what's inside (see transactionPayload.ts for that, and
 * its own header comment on what it deliberately doesn't verify).
 *
 * Throws on anything but a 200: a non-200 here means Apple itself
 * rejected the request (unknown transaction, bad auth, revoked key),
 * which the caller should treat the same as "reject, don't write an
 * entitlement" rather than silently swallowing. `fetchImpl` is
 * injectable specifically so this can be unit tested without a real
 * network call to Apple — this project has no App Store Connect
 * credentials to call the real endpoint with anyway.
 */
export async function fetchTransactionInfo(transactionId: string, config: AppStoreClientConfig, fetchImpl: FetchLike = fetch): Promise<string> {
  const base = config.sandbox ? SANDBOX_BASE : PRODUCTION_BASE;
  const jwt = signAppStoreJwt(config);
  const response = await fetchImpl(`${base}/inApps/v1/transactions/${encodeURIComponent(transactionId)}`, {
    headers: { Authorization: `Bearer ${jwt}` },
  });
  if (!response.ok) {
    throw new Error(`App Store Server API responded ${response.status}`);
  }
  const body = (await response.json()) as { signedTransactionInfo?: unknown };
  if (typeof body.signedTransactionInfo !== 'string') {
    throw new Error('App Store Server API response missing signedTransactionInfo');
  }
  return body.signedTransactionInfo;
}
