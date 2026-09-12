import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { REPORT_THRESHOLD, shouldHideClip } from './moderation.js';

describe('shouldHideClip', () => {
  test('below the threshold, the clip stays visible', () => {
    assert.equal(shouldHideClip(0), false);
  });

  test('at the threshold, the clip is hidden', () => {
    assert.equal(shouldHideClip(REPORT_THRESHOLD), true);
  });

  test('well past the threshold, the clip stays hidden', () => {
    assert.equal(shouldHideClip(REPORT_THRESHOLD + 50), true);
  });
});
