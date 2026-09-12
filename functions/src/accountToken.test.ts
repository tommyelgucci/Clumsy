import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { deriveAppAccountToken } from './accountToken.js';

describe('deriveAppAccountToken', () => {
  test('is deterministic — the same uid always derives the same token', () => {
    assert.equal(deriveAppAccountToken('alice'), deriveAppAccountToken('alice'));
  });

  test('different uids derive different tokens', () => {
    assert.notEqual(deriveAppAccountToken('alice'), deriveAppAccountToken('bob'));
  });

  test('produces a well-formed UUIDv5 string (version and variant bits set)', () => {
    const token = deriveAppAccountToken('alice');
    assert.match(token, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
