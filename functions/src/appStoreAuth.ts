import { createSign } from 'node:crypto';

/**
 * ES256 JWT generation for authenticating to Apple's App Store Server
 * API (task 3.4) — the credential this Cloud Function presents as
 * itself, not a user's transaction data. Built with Node's own `crypto`
 * module rather than adding a JWT-signing dependency: ES256 is exactly
 * `SHA256withECDSA` over the base64url-encoded `header.payload`, and
 * Node's `dsaEncoding: 'ieee-p1363'` option produces the fixed-length
 * raw r||s signature JWS itself requires directly — no separate
 * DER-to-raw conversion step needed.
 *
 * Apple's own documented claim requirements: `iss` (issuer ID from App
 * Store Connect), `iat`/`exp` (max 60 minutes apart), `aud` fixed to
 * "appstoreconnect-v1", `bid` (bundle ID), and a `kid` header naming
 * which App Store Connect API key signed it. None of this can be
 * exercised against the real API without a real App Store Connect
 * private key (`.p8` file) and IDs, which this project has none of —
 * `appStoreAuth.test.ts` verifies the JWT's own shape and claims using a
 * throwaway ES256 keypair generated at test time, not a real Apple key.
 */
export interface AppStoreAuthConfig {
  keyId: string;
  issuerId: string;
  bundleId: string;
  /** PEM-encoded EC private key (the contents of App Store Connect's
   *  downloaded `.p8` file). */
  privateKeyPem: string;
}

function base64url(input: Buffer): string {
  return input.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Signs a fresh App Store Server API auth token, valid for `ttlSeconds`
 *  (Apple caps this at 3600; defaults to 20 minutes, comfortably under
 *  that with room to spare for clock skew). */
export function signAppStoreJwt(config: AppStoreAuthConfig, now = Date.now(), ttlSeconds = 1200): string {
  const iat = Math.floor(now / 1000);
  const header = { alg: 'ES256', kid: config.keyId, typ: 'JWT' };
  const payload = {
    iss: config.issuerId,
    iat,
    exp: iat + ttlSeconds,
    aud: 'appstoreconnect-v1',
    bid: config.bundleId,
  };

  const encodedHeader = base64url(Buffer.from(JSON.stringify(header)));
  const encodedPayload = base64url(Buffer.from(JSON.stringify(payload)));
  const signingInput = `${encodedHeader}.${encodedPayload}`;

  const signature = createSign('SHA256').update(signingInput).sign({ key: config.privateKeyPem, dsaEncoding: 'ieee-p1363' });

  return `${signingInput}.${base64url(signature)}`;
}
