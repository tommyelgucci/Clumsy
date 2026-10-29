/** Unit tests for clipModel.ts with Node's native runner, same as the
 *  `src/core/` tests — nothing here touches Firebase. */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  APP_HASHTAG,
  MAX_CAPTION_LENGTH,
  buildClipFields,
  clipStoragePath,
  filterBlocked,
  isReportReason,
  normalizeCaption,
  reportDocId,
  shareCaption,
} from './clipModel.ts';

describe('normalizeCaption', () => {
  test('trims and collapses whitespace into one line', () => {
    assert.equal(normalizeCaption('  a   walk\n\ncycle \t'), 'a walk cycle');
  });
  test('caps at the rules limit', () => {
    assert.equal(normalizeCaption('x'.repeat(500)).length, MAX_CAPTION_LENGTH);
  });
  test('never splits an emoji at the cut', () => {
    const out = normalizeCaption('😀'.repeat(150));
    assert.ok(out.length <= MAX_CAPTION_LENGTH);
    assert.equal(out, '😀'.repeat(out.length / 2));
    assert.ok(!/[\ud800-\udbff]$/.test(out));
  });
  test('does not leave a trailing space where it cuts', () => {
    const out = normalizeCaption('x'.repeat(MAX_CAPTION_LENGTH - 1) + ' tail');
    assert.equal(out, 'x'.repeat(MAX_CAPTION_LENGTH - 1));
  });
  test('an all-whitespace caption becomes empty', () => {
    assert.equal(normalizeCaption(' \n\t '), '');
  });
});

describe('shareCaption', () => {
  test('appends the app hashtag', () => {
    assert.equal(shareCaption('my loop'), `my loop ${APP_HASHTAG}`);
  });
  test('is just the hashtag when there is no caption', () => {
    assert.equal(shareCaption('   '), APP_HASHTAG);
  });
});

describe('buildClipFields', () => {
  const input = { ownerId: 'alice', clipId: 'c1', videoUrl: 'https://x/y.mp4', caption: ' hi ', width: 360, height: 640, fps: 12, frames: 3 };
  test('binds the storage path to owner and clip id', () => {
    assert.equal(buildClipFields(input).storagePath, clipStoragePath('alice', 'c1'));
    assert.equal(clipStoragePath('alice', 'c1'), 'clips/alice/c1');
  });
  test('is never pre-hidden', () => {
    assert.equal(buildClipFields(input).hidden, false);
  });
  test('omits an empty caption instead of storing ""', () => {
    assert.ok(!('caption' in buildClipFields({ ...input, caption: '  ' })));
    assert.equal(buildClipFields(input).caption, 'hi');
  });
  test('carries exactly the fields the rules allow (createdAt is added by the caller)', () => {
    assert.deepEqual(Object.keys(buildClipFields(input)).sort(), ['caption', 'fps', 'frames', 'height', 'hidden', 'ownerId', 'storagePath', 'videoUrl', 'width']);
  });
});

describe('filterBlocked', () => {
  const clips = [{ ownerId: 'a' }, { ownerId: 'b' }, { ownerId: 'a' }];
  test('drops every clip by a blocked author', () => {
    assert.deepEqual(filterBlocked(clips, new Set(['a'])), [{ ownerId: 'b' }]);
  });
  test('returns the clips untouched when nobody is blocked', () => {
    assert.equal(filterBlocked(clips, new Set()), clips);
  });
});

describe('reports', () => {
  test('the report id is stable per (clip, reporter)', () => {
    assert.equal(reportDocId('c1', 'bob'), reportDocId('c1', 'bob'));
    assert.notEqual(reportDocId('c1', 'bob'), reportDocId('c1', 'carol'));
  });
  test('only known reasons are accepted', () => {
    assert.ok(isReportReason('spam'));
    assert.ok(!isReportReason('because'));
  });
});
