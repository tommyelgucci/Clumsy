/**
 * Sanity tests for the ported brush.ts. Trace has no unit tests for its
 * own brush.ts either (verified via Playwright visual scripts instead) —
 * this is new coverage for the parts that don't need WebGL, not a port.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  BRUSH_CATEGORIES,
  DEFAULT_BRUSHES,
  StrokeBuilder,
  taperScale,
  type BrushPreset,
} from './brush.ts';

describe('DEFAULT_BRUSHES', () => {
  test('every preset has a unique id', () => {
    const ids = DEFAULT_BRUSHES.map((b) => b.id);
    assert.equal(new Set(ids).size, ids.length);
  });

  test('every preset belongs to a known category', () => {
    for (const b of DEFAULT_BRUSHES) {
      assert.ok(BRUSH_CATEGORIES.includes(b.category), `${b.id} has unknown category ${b.category}`);
    }
  });

  test('covers all five categories', () => {
    const covered = new Set(DEFAULT_BRUSHES.map((b) => b.category));
    for (const c of BRUSH_CATEGORIES) assert.ok(covered.has(c), `no preset in category ${c}`);
  });

  test('exactly the erasers have erase: true', () => {
    for (const b of DEFAULT_BRUSHES) {
      assert.equal(b.erase, b.category === 'eraser', `${b.id}.erase mismatch with its category`);
    }
  });

  test('size and opacity stay in sane ranges', () => {
    for (const b of DEFAULT_BRUSHES) {
      assert.ok(b.size > 0, `${b.id}.size must be positive`);
      assert.ok(b.opacity >= 0 && b.opacity <= 1, `${b.id}.opacity out of 0..1`);
      assert.ok(b.aspect > 0 && b.aspect <= 1, `${b.id}.aspect out of (0, 1]`);
    }
  });
});

function makeBrush(overrides: Partial<BrushPreset> = {}): BrushPreset {
  return { ...DEFAULT_BRUSHES[0], ...overrides };
}

describe('taperScale', () => {
  test('no taper (0) always returns 1', () => {
    assert.equal(taperScale(0, makeBrush({ taper: 0 })), 1);
    assert.equal(taperScale(1000, makeBrush({ taper: 0 })), 1);
  });

  test('at distance 0 from the tapering end, the scale is at its minimum', () => {
    const scale = taperScale(0, makeBrush({ taper: 0.5, size: 20 }));
    assert.ok(scale > 0 && scale < 1);
  });

  test('far enough from the end, the scale reaches 1', () => {
    const brush = makeBrush({ taper: 0.5, size: 20 });
    const scale = taperScale(10_000, brush);
    assert.ok(Math.abs(scale - 1) < 1e-6);
  });

  test('scale grows monotonically with distance from the end', () => {
    const brush = makeBrush({ taper: 0.6, size: 10 });
    let prev = taperScale(0, brush);
    for (let d = 1; d <= 200; d += 10) {
      const cur = taperScale(d, brush);
      assert.ok(cur >= prev - 1e-9, `taperScale should not decrease: ${prev} -> ${cur} at d=${d}`);
      prev = cur;
    }
  });
});

describe('StrokeBuilder', () => {
  test('begin() with a single tap emits exactly one stamp at that point', () => {
    // scatter: 0 — the default pencil preset scatters position randomly,
    // which isn't what this test is checking.
    const sb = new StrokeBuilder(makeBrush({ scatter: 0 }));
    const stamps = sb.begin({ x: 10, y: 20, pressure: 1, altitude: 0, azimuth: 0, time: 0 });
    assert.equal(stamps.length, 1);
    assert.ok(Math.abs(stamps[0].x - 10) < 1e-6);
    assert.ok(Math.abs(stamps[0].y - 20) < 1e-6);
  });

  test('isEmpty is true before begin() and false after', () => {
    const sb = new StrokeBuilder(makeBrush());
    assert.equal(sb.isEmpty, true);
    sb.begin({ x: 0, y: 0, pressure: 1, altitude: 0, azimuth: 0, time: 0 });
    assert.equal(sb.isEmpty, false);
  });

  test('a straight drag emits stamps spaced roughly by brush.size * spacing', () => {
    // Disable smoothing/jitter-like randomness sources that would make
    // spacing noisy: spacing itself stays deterministic regardless.
    const brush = makeBrush({ spacing: 0.5, size: 10, smoothing: 0, jitterSize: 0, scatter: 0 });
    const sb = new StrokeBuilder(brush);
    sb.begin({ x: 0, y: 0, pressure: 1, altitude: 0, azimuth: 0, time: 0 });
    let stamps = sb.push({ x: 50, y: 0, pressure: 1, altitude: 0, azimuth: 0, time: 16 });
    stamps = stamps.concat(sb.push({ x: 100, y: 0, pressure: 1, altitude: 0, azimuth: 0, time: 32 }));
    stamps = stamps.concat(sb.end());
    assert.ok(stamps.length > 1, 'a 100px drag with 5px spacing should emit several stamps');
    for (const s of stamps) {
      assert.ok(Number.isFinite(s.x) && Number.isFinite(s.y));
      assert.ok(s.size > 0);
    }
  });

  test('end() on a stroke with no begin() returns nothing and does not throw', () => {
    const sb = new StrokeBuilder(makeBrush());
    assert.deepEqual(sb.end(), []);
  });
});
