import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { decideEntitlement } from './entitlement.js';
import type { TransactionInfo } from './transactionPayload.js';

const base: TransactionInfo = {
  transactionId: 't1',
  productId: 'pro_yearly',
  bundleId: 'com.clumsyloop.app',
  expiresDate: null,
  revocationDate: null,
  environment: 'Sandbox',
  appAccountToken: 'aaaaaaaa-bbbb-5ccc-8ddd-eeeeeeeeeeee',
};

describe('decideEntitlement', () => {
  test('a non-expiring, non-revoked transaction is active', () => {
    assert.deepEqual(decideEntitlement(base, Date.now()), { active: true, productId: 'pro_yearly' });
  });

  test('a subscription still within its expiry window is active', () => {
    const info = { ...base, expiresDate: Date.now() + 1000 * 60 * 60 };
    assert.equal(decideEntitlement(info, Date.now()).active, true);
  });

  test('a subscription past its expiry date is not active', () => {
    const info = { ...base, expiresDate: Date.now() - 1000 };
    assert.equal(decideEntitlement(info, Date.now()).active, false);
  });

  test('a revoked transaction is not active even if not yet expired', () => {
    const info = { ...base, expiresDate: Date.now() + 1000 * 60 * 60, revocationDate: Date.now() - 1000 };
    assert.equal(decideEntitlement(info, Date.now()).active, false);
  });

  test('the productId always comes through unchanged', () => {
    const info = { ...base, productId: 'lifetime_unlock' };
    assert.equal(decideEntitlement(info, Date.now()).productId, 'lifetime_unlock');
  });
});
