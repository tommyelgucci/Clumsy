import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { ReceiptRejected, validateReceipt } from './validateReceipt.js';

const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const config = {
  keyId: 'k',
  issuerId: 'i',
  bundleId: 'com.clumsyloop.app',
  privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
};

function jwsWithPayload(payload: unknown): string {
  const b64url = (s: string) => Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${b64url(JSON.stringify({ alg: 'ES256' }))}.${b64url(JSON.stringify(payload))}.sig`;
}

function fetchReturning(signedTransactionInfo: string): typeof fetch {
  return (async () => new Response(JSON.stringify({ signedTransactionInfo }), { status: 200 })) as typeof fetch;
}

const accountToken = 'aaaaaaaa-bbbb-5ccc-8ddd-eeeeeeeeeeee';

const validPayload = {
  transactionId: 't1',
  productId: 'pro_yearly',
  bundleId: 'com.clumsyloop.app',
  expiresDate: null,
  revocationDate: null,
  environment: 'Sandbox',
  appAccountToken: accountToken,
};

describe('validateReceipt', () => {
  test('acceptance: a valid sandbox transaction produces an active entitlement to write', async () => {
    const fetchImpl = fetchReturning(jwsWithPayload(validPayload));
    const update = await validateReceipt('t1', 'com.clumsyloop.app', accountToken, config, fetchImpl);
    assert.deepEqual(update, { active: true, productId: 'pro_yearly' });
  });

  test('acceptance: a fake transaction ID (Apple itself refuses it) is rejected, producing nothing to write', async () => {
    const fetchImpl = (async () => new Response('{}', { status: 404 })) as typeof fetch;
    await assert.rejects(() => validateReceipt('does-not-exist', 'com.clumsyloop.app', accountToken, config, fetchImpl), ReceiptRejected);
  });

  test('acceptance: a tampered payload (malformed shape) is rejected, producing nothing to write', async () => {
    const fetchImpl = fetchReturning(jwsWithPayload({ transactionId: 't1' /* missing everything else */ }));
    await assert.rejects(() => validateReceipt('t1', 'com.clumsyloop.app', accountToken, config, fetchImpl), ReceiptRejected);
  });

  test('rejects a transaction that is genuinely for a different app', async () => {
    const fetchImpl = fetchReturning(jwsWithPayload({ ...validPayload, bundleId: 'com.someoneelse.app' }));
    await assert.rejects(() => validateReceipt('t1', 'com.clumsyloop.app', accountToken, config, fetchImpl), ReceiptRejected);
  });

  test('an expired subscription still resolves — an inactive entitlement, not a rejection', async () => {
    const fetchImpl = fetchReturning(jwsWithPayload({ ...validPayload, expiresDate: Date.now() - 1000 }));
    const update = await validateReceipt('t1', 'com.clumsyloop.app', accountToken, config, fetchImpl);
    assert.deepEqual(update, { active: false, productId: 'pro_yearly' });
  });

  test('rejects a transaction bound to a different account (someone else\'s real transaction ID reused)', async () => {
    const fetchImpl = fetchReturning(jwsWithPayload(validPayload));
    await assert.rejects(() => validateReceipt('t1', 'com.clumsyloop.app', 'a-different-caller-token', config, fetchImpl), ReceiptRejected);
  });

  test('rejects a transaction nobody bound to any account (appAccountToken never set)', async () => {
    const { appAccountToken, ...unbound } = validPayload;
    void appAccountToken;
    const fetchImpl = fetchReturning(jwsWithPayload(unbound));
    await assert.rejects(() => validateReceipt('t1', 'com.clumsyloop.app', accountToken, config, fetchImpl), ReceiptRejected);
  });
});
