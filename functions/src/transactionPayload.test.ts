import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { decodeJwsPayload, parseTransactionInfo } from './transactionPayload.js';

function fakeJws(payload: unknown): string {
  const b64url = (s: string) => Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const header = b64url(JSON.stringify({ alg: 'ES256', x5c: ['not-a-real-cert'] }));
  const body = b64url(JSON.stringify(payload));
  // A signature-shaped third segment — decodeJwsPayload never checks it,
  // by design (see the module's own header comment).
  return `${header}.${body}.fake-signature`;
}

describe('decodeJwsPayload', () => {
  test('decodes a well-formed three-part JWS payload', () => {
    const decoded = decodeJwsPayload(fakeJws({ transactionId: 't1' }));
    assert.deepEqual(decoded, { transactionId: 't1' });
  });

  test('returns null for something that is not three dot-separated parts', () => {
    assert.equal(decodeJwsPayload('not-a-jws'), null);
    assert.equal(decodeJwsPayload('a.b'), null);
  });

  test('returns null when the payload segment is not valid JSON', () => {
    const notJson = Buffer.from('not json').toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
    assert.equal(decodeJwsPayload(`header.${notJson}.sig`), null);
  });
});

describe('parseTransactionInfo', () => {
  const validPayload = {
    transactionId: 't1',
    productId: 'pro_yearly',
    bundleId: 'com.clumsyloop.app',
    expiresDate: 1_800_000_000_000,
    revocationDate: null,
    environment: 'Sandbox',
  };

  test('parses a well-formed payload', () => {
    const info = parseTransactionInfo(validPayload);
    assert.deepEqual(info, validPayload);
  });

  test('accepts a missing expiresDate/revocationDate as null (a lifetime, never-revoked purchase)', () => {
    const { expiresDate, revocationDate, ...rest } = validPayload;
    void expiresDate;
    void revocationDate;
    const info = parseTransactionInfo(rest);
    assert.equal(info?.expiresDate, null);
    assert.equal(info?.revocationDate, null);
  });

  test('rejects a payload missing a required field', () => {
    const { productId, ...rest } = validPayload;
    void productId;
    assert.equal(parseTransactionInfo(rest), null);
  });

  test('rejects an invalid environment value', () => {
    assert.equal(parseTransactionInfo({ ...validPayload, environment: 'Production2' }), null);
  });

  test('rejects a non-numeric expiresDate', () => {
    assert.equal(parseTransactionInfo({ ...validPayload, expiresDate: 'soon' }), null);
  });

  test('rejects a non-object payload entirely (e.g. decodeJwsPayload already returned null)', () => {
    assert.equal(parseTransactionInfo(null), null);
    assert.equal(parseTransactionInfo('a string'), null);
  });
});
