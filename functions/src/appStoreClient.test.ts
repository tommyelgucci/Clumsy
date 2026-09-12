import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { fetchTransactionInfo } from './appStoreClient.js';

const config = { keyId: 'k', issuerId: 'i', bundleId: 'com.clumsyloop.app', privateKeyPem: '-----BEGIN EC PRIVATE KEY-----\nfake\n-----END EC PRIVATE KEY-----' };

// A fake key that isn't a real PEM would make `signAppStoreJwt` throw
// when it actually tries to sign — these tests only exercise the HTTP
// round trip, so they stub `fetch` before signing ever runs into that.
// (signAppStoreJwt's own real-key behavior is covered by
// appStoreAuth.test.ts.)

describe('fetchTransactionInfo', () => {
  test('returns signedTransactionInfo from a 200 response', async () => {
    const fakeFetch = (async () => new Response(JSON.stringify({ signedTransactionInfo: 'a.b.c' }), { status: 200 })) as typeof fetch;
    // signAppStoreJwt needs a real EC key to sign with — swap in a real
    // throwaway one just for this call.
    const { generateKeyPairSync } = await import('node:crypto');
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const realConfig = { ...config, privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() };
    const result = await fetchTransactionInfo('txn-1', realConfig, fakeFetch);
    assert.equal(result, 'a.b.c');
  });

  test('throws on a non-200 response, rather than returning something falsy', async () => {
    const { generateKeyPairSync } = await import('node:crypto');
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const realConfig = { ...config, privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() };
    const fakeFetch = (async () => new Response('{}', { status: 404 })) as typeof fetch;
    await assert.rejects(() => fetchTransactionInfo('unknown-txn', realConfig, fakeFetch));
  });

  test('throws when the response is 200 but missing signedTransactionInfo', async () => {
    const { generateKeyPairSync } = await import('node:crypto');
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const realConfig = { ...config, privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() };
    const fakeFetch = (async () => new Response('{}', { status: 200 })) as typeof fetch;
    await assert.rejects(() => fetchTransactionInfo('txn-1', realConfig, fakeFetch));
  });

  test('sends the transaction ID in the URL and a bearer token in the auth header', async () => {
    const { generateKeyPairSync } = await import('node:crypto');
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const realConfig = { ...config, privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), sandbox: true };
    let capturedUrl = '';
    let capturedAuth = '';
    const fakeFetch = (async (url: string | URL, init?: RequestInit) => {
      capturedUrl = String(url);
      capturedAuth = String((init?.headers as Record<string, string> | undefined)?.Authorization ?? '');
      return new Response(JSON.stringify({ signedTransactionInfo: 'x' }), { status: 200 });
    }) as typeof fetch;
    await fetchTransactionInfo('txn-42', realConfig, fakeFetch);
    assert.match(capturedUrl, /storekit-sandbox\.itunes\.apple\.com\/inApps\/v1\/transactions\/txn-42$/);
    assert.match(capturedAuth, /^Bearer .+\..+\..+$/);
  });
});
