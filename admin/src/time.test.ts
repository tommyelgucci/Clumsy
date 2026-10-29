import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { dueStatus, formatSpan, tallyReasons } from './time.ts';

const H = 3_600_000;

describe('formatSpan', () => {
  test('hours and minutes, or minutes alone under an hour', () => {
    assert.equal(formatSpan(5 * H + 12 * 60_000), '5h 12m');
    assert.equal(formatSpan(42 * 60_000), '42m');
    assert.equal(formatSpan(0), '0m');
  });
  test('never negative', () => {
    assert.equal(formatSpan(-5 * H), '0m');
  });
});

describe('dueStatus', () => {
  test('plenty of time is ok', () => {
    assert.deepEqual(dueStatus(20 * H, 0), { urgency: 'ok', label: 'due in 20h 0m' });
  });
  test('the last four hours are "soon"', () => {
    assert.equal(dueStatus(4 * H, 0).urgency, 'soon');
    assert.equal(dueStatus(4 * H + 1, 0).urgency, 'ok');
  });
  test('past the deadline is overdue and says by how much', () => {
    assert.deepEqual(dueStatus(0, 3 * H), { urgency: 'overdue', label: 'OVERDUE by 3h 0m' });
    assert.equal(dueStatus(5, 5).urgency, 'overdue');
  });
});

describe('tallyReasons', () => {
  test('counts repeats, most common first, ties alphabetical', () => {
    assert.equal(tallyReasons(['spam', 'harassment', 'spam']), 'spam ×2, harassment');
    assert.equal(tallyReasons(['b', 'a']), 'a, b');
    assert.equal(tallyReasons([]), '');
  });
});
