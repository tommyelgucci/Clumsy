import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { REVIEW_DEADLINE_MS, buildQueue, isSafeStoragePath, parseReviewRequest, type ClipRow, type ReportRow } from './review.js';

describe('parseReviewRequest', () => {
  test('accepts a restore and a delete', () => {
    assert.deepEqual(parseReviewRequest({ clipId: 'c1', decision: 'restore' }), { clipId: 'c1', decision: 'restore' });
    assert.deepEqual(parseReviewRequest({ clipId: 'c1', decision: 'delete' }), { clipId: 'c1', decision: 'delete' });
  });
  test('rejects a missing, empty, oversized or path-like clip id', () => {
    for (const clipId of [undefined, '', 'a/b', '../x', 'x'.repeat(201), 5]) {
      assert.throws(() => parseReviewRequest({ clipId, decision: 'delete' }), /clipId/);
    }
  });
  test('rejects any decision but restore/delete', () => {
    for (const decision of [undefined, 'ban', 'DELETE', '']) {
      assert.throws(() => parseReviewRequest({ clipId: 'c1', decision }), /decision/);
    }
  });
  test('rejects a body that is not an object', () => {
    assert.throws(() => parseReviewRequest(null), /clipId/);
    assert.throws(() => parseReviewRequest('x'), /clipId/);
  });
});

describe('isSafeStoragePath', () => {
  test("only the owner's own path for this clip is safe", () => {
    assert.ok(isSafeStoragePath('clips/alice/c1', 'alice', 'c1'));
    assert.ok(!isSafeStoragePath('clips/bob/c1', 'alice', 'c1'));
    assert.ok(!isSafeStoragePath('clips/alice/other', 'alice', 'c1'));
    assert.ok(!isSafeStoragePath('clips/alice/c1/../../secrets', 'alice', 'c1'));
    assert.ok(!isSafeStoragePath(undefined, 'alice', 'c1'));
  });
});

describe('buildQueue', () => {
  const clip = (id: string): ClipRow => ({ id, ownerId: 'o', caption: id, videoUrl: `u/${id}`, hidden: true, createdAtMs: 0 });
  const report = (clipId: string, reporterId: string, createdAtMs: number, reason = 'spam'): ReportRow => ({ clipId, reporterId, reason, createdAtMs });

  test('lists one entry per clip, oldest report first', () => {
    const q = buildQueue(
      [report('b', 'x', 500), report('a', 'y', 100), report('a', 'z', 900)],
      new Map([['a', clip('a')], ['b', clip('b')]]),
    );
    assert.deepEqual(q.map((i) => i.id), ['a', 'b']);
    assert.equal(q[0].reports.length, 2);
  });
  test("a clip's deadline is 24h after its OLDEST report", () => {
    const [item] = buildQueue([report('a', 'y', 900), report('a', 'z', 100)], new Map([['a', clip('a')]]));
    assert.equal(item.oldestReportMs, 100);
    assert.equal(item.dueAtMs, 100 + REVIEW_DEADLINE_MS);
    assert.deepEqual(item.reports.map((r) => r.createdAtMs), [100, 900]);
  });
  test('reports for a clip that no longer exists drop out', () => {
    assert.deepEqual(buildQueue([report('gone', 'x', 1)], new Map()), []);
  });
  test('an empty report list is an empty queue', () => {
    assert.deepEqual(buildQueue([], new Map([['a', clip('a')]])), []);
  });
});
