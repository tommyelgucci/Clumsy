import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createVerify } from 'node:crypto';
import { signAppStoreJwt } from './appStoreAuth.js';

function decodeSegment(segment: string): any {
  const padded = segment.replace(/-/g, '+').replace(/_/g, '/');
  return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
}

// A throwaway P-256 keypair generated for this test run only — not a
// real Apple App Store Connect key, which this project has none of.
const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

describe('signAppStoreJwt', () => {
  test('produces a three-part JWT with the right header and claims', () => {
    const now = Date.parse('2026-01-01T00:00:00Z');
    const jwt = signAppStoreJwt({ keyId: 'ABC123', issuerId: 'issuer-xyz', bundleId: 'com.clumsyloop.app', privateKeyPem }, now);
    const parts = jwt.split('.');
    assert.equal(parts.length, 3);

    const header = decodeSegment(parts[0]);
    assert.deepEqual(header, { alg: 'ES256', kid: 'ABC123', typ: 'JWT' });

    const payload = decodeSegment(parts[1]);
    assert.equal(payload.iss, 'issuer-xyz');
    assert.equal(payload.bid, 'com.clumsyloop.app');
    assert.equal(payload.aud, 'appstoreconnect-v1');
    assert.equal(payload.iat, Math.floor(now / 1000));
    assert.equal(payload.exp, Math.floor(now / 1000) + 1200);
  });

  test('the signature actually verifies against the signing key’s public half', () => {
    const jwt = signAppStoreJwt({ keyId: 'k', issuerId: 'i', bundleId: 'b', privateKeyPem });
    const [h, p, s] = jwt.split('.');
    const signingInput = `${h}.${p}`;
    const signature = Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

    const ok = createVerify('SHA256').update(signingInput).verify({ key: publicKey, dsaEncoding: 'ieee-p1363' }, signature);
    assert.equal(ok, true);
  });

  test('a signature does not verify against a different key', () => {
    const other = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const jwt = signAppStoreJwt({ keyId: 'k', issuerId: 'i', bundleId: 'b', privateKeyPem });
    const [h, p, s] = jwt.split('.');
    const signature = Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

    const ok = createVerify('SHA256').update(`${h}.${p}`).verify({ key: other.publicKey, dsaEncoding: 'ieee-p1363' }, signature);
    assert.equal(ok, false);
  });
});
