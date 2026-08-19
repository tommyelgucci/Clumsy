/**
 * Unit tests for math.ts with Node's native runner (`node --test`) — no new
 * dependency needed: Node 22 runs TypeScript directly, and these functions
 * are pure, no DOM or WebGL involved, so no browser is needed to test them.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  clamp,
  lerp,
  snapAngle,
  mat3Identity,
  mat3Multiply,
  mat3FromTRS,
  mat3Invert,
  mat3Apply,
  hsvToRgb,
  rgbToHsv,
  rgbToHex,
  hexToRgb,
  OneEuroFilter,
} from './math.ts';

const closeTo = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) <= eps;

describe('clamp', () => {
  test('lets values inside the range through', () => {
    assert.equal(clamp(5, 0, 10), 5);
  });
  test('clamps below', () => {
    assert.equal(clamp(-3, 0, 10), 0);
  });
  test('clamps above', () => {
    assert.equal(clamp(15, 0, 10), 10);
  });
});

describe('lerp', () => {
  test('t=0 gives the first value', () => assert.equal(lerp(2, 8, 0), 2));
  test('t=1 gives the second value', () => assert.equal(lerp(2, 8, 1), 8));
  test('t=0.5 gives the midpoint', () => assert.equal(lerp(2, 8, 0.5), 5));
  test('extrapolates outside 0..1', () => assert.equal(lerp(0, 10, 2), 20));
});

describe('snapAngle', () => {
  test('rounds to the nearest increment', () => {
    const step = Math.PI / 12; // 15°
    // 20° is closer to 15° than to 30°.
    const twentyDeg = (20 * Math.PI) / 180;
    assert.ok(closeTo(snapAngle(twentyDeg, step), step));
  });
  test('an already-exact angle stays put', () => {
    const step = Math.PI / 12;
    assert.ok(closeTo(snapAngle(step * 3, step), step * 3));
  });
});

describe('3x3 matrices', () => {
  test('the identity does not transform a point', () => {
    const p = mat3Apply(mat3Identity(), { x: 5, y: -3 });
    assert.ok(closeTo(p.x, 5) && closeTo(p.y, -3));
  });

  test('multiplying by the identity does not change the matrix', () => {
    const m = mat3FromTRS(10, 20, 0.3, 2, 1.5);
    const out = mat3Multiply(m, mat3Identity());
    for (let i = 0; i < 9; i++) assert.ok(closeTo(out[i], m[i]));
  });

  test('pure translation moves the point by exactly that', () => {
    const m = mat3FromTRS(10, -5, 0, 1, 1);
    const p = mat3Apply(m, { x: 1, y: 1 });
    assert.ok(closeTo(p.x, 11) && closeTo(p.y, -4));
  });

  test('pure scale from the origin', () => {
    const m = mat3FromTRS(0, 0, 0, 2, 3);
    const p = mat3Apply(m, { x: 4, y: 4 });
    assert.ok(closeTo(p.x, 8) && closeTo(p.y, 12));
  });

  test('a 90° rotation takes (1,0) to (0,1)', () => {
    const m = mat3FromTRS(0, 0, Math.PI / 2, 1, 1);
    const p = mat3Apply(m, { x: 1, y: 0 });
    assert.ok(closeTo(p.x, 0) && closeTo(p.y, 1));
  });

  test('the rotation origin does not move itself', () => {
    const m = mat3FromTRS(5, 5, Math.PI / 3, 1.4, 0.7, 100, 200);
    const p = mat3Apply(m, { x: 100, y: 200 });
    // Mat3 is a Float32Array: with large origin coordinates (100, 200) the
    // single-precision rounding is around 1e-6 in the result, more than
    // closeTo's default eps.
    assert.ok(closeTo(p.x, 105, 1e-3) && closeTo(p.y, 205, 1e-3));
  });

  test('inverting and applying undoes the original transform', () => {
    const m = mat3FromTRS(12, -7, 0.9, 1.7, 0.6, 10, -3);
    const inv = mat3Invert(m);
    const original = { x: 33, y: -12 };
    const roundTrip = mat3Apply(inv, mat3Apply(m, original));
    assert.ok(closeTo(roundTrip.x, original.x, 1e-4));
    assert.ok(closeTo(roundTrip.y, original.y, 1e-4));
  });

  test('inverting a singular matrix does not blow up: returns the identity', () => {
    // Scale 0 on one axis: determinant 0.
    const singular = mat3FromTRS(0, 0, 0, 0, 1);
    const inv = mat3Invert(singular);
    assert.deepEqual(Array.from(inv), Array.from(mat3Identity()));
  });
});

describe('color', () => {
  test('hsvToRgb of pure red', () => {
    const c = hsvToRgb(0, 1, 1);
    assert.ok(closeTo(c.r, 1) && closeTo(c.g, 0) && closeTo(c.b, 0));
  });

  test('hsvToRgb of a gray (s=0) gives the same value on all three channels', () => {
    const c = hsvToRgb(0.37, 0, 0.6);
    assert.ok(closeTo(c.r, 0.6) && closeTo(c.g, 0.6) && closeTo(c.b, 0.6));
  });

  test('hsvToRgb / rgbToHsv round-trip', () => {
    for (const [h, s, v] of [
      [0.05, 0.8, 0.9],
      [0.5, 0.4, 0.7],
      [0.83, 1, 0.5],
    ]) {
      const rgb = hsvToRgb(h, s, v);
      const back = rgbToHsv(rgb);
      assert.ok(closeTo(back.h, h, 1e-4), `h: ${back.h} vs ${h}`);
      assert.ok(closeTo(back.s, s, 1e-4), `s: ${back.s} vs ${s}`);
      assert.ok(closeTo(back.v, v, 1e-4), `v: ${back.v} vs ${v}`);
    }
  });

  test('rgbToHsv of pure white has no saturation', () => {
    const hsv = rgbToHsv({ r: 1, g: 1, b: 1 });
    assert.equal(hsv.s, 0);
    assert.equal(hsv.v, 1);
  });

  test('rgbToHsv of pure black does not divide by zero', () => {
    const hsv = rgbToHsv({ r: 0, g: 0, b: 0 });
    assert.equal(hsv.s, 0);
    assert.equal(hsv.v, 0);
  });

  test('rgbToHex of pure red', () => {
    assert.equal(rgbToHex({ r: 1, g: 0, b: 0 }), '#ff0000');
  });

  test('rgbToHex clamps values outside 0..1', () => {
    assert.equal(rgbToHex({ r: 2, g: -1, b: 0.5 }), '#ff0080');
  });

  test('hexToRgb of a known color', () => {
    const c = hexToRgb('#3366cc');
    assert.ok(closeTo(c.r, 0x33 / 255, 1e-3));
    assert.ok(closeTo(c.g, 0x66 / 255, 1e-3));
    assert.ok(closeTo(c.b, 0xcc / 255, 1e-3));
  });

  test('hexToRgb accepts no leading hash', () => {
    const c = hexToRgb('ff0000');
    assert.ok(closeTo(c.r, 1) && closeTo(c.g, 0) && closeTo(c.b, 0));
  });

  test('hexToRgb with an invalid format does not throw — returns black', () => {
    assert.deepEqual(hexToRgb('not a color'), { r: 0, g: 0, b: 0 });
  });

  test('rgbToHex / hexToRgb round-trip', () => {
    const original = { r: 0.2, g: 0.6, b: 0.9 };
    const back = hexToRgb(rgbToHex(original));
    assert.ok(closeTo(back.r, original.r, 1 / 255));
    assert.ok(closeTo(back.g, original.g, 1 / 255));
    assert.ok(closeTo(back.b, original.b, 1 / 255));
  });
});

describe('OneEuroFilter', () => {
  test('the first sample comes out unchanged', () => {
    const f = new OneEuroFilter();
    assert.equal(f.filter(10, 0), 10);
  });

  test('smooths noise around a constant value', () => {
    const f = new OneEuroFilter();
    let t = 0;
    let last = f.filter(10, t);
    // Small, constant noise around 10, sampled at 60 Hz.
    for (let i = 0; i < 60; i++) {
      t += 1000 / 60;
      const noisy = 10 + (i % 2 === 0 ? 0.5 : -0.5);
      last = f.filter(noisy, t);
    }
    // Doesn't remove the noise entirely, but pulls it much closer to 10
    // than an unfiltered sample would be (which oscillates ±0.5).
    assert.ok(closeTo(last, 10, 0.3), `${last} should be around 10`);
  });

  test('reset() forgets its state and the next sample comes out exact again', () => {
    const f = new OneEuroFilter();
    f.filter(10, 0);
    f.filter(50, 16);
    f.reset();
    assert.equal(f.filter(3, 100), 3);
  });

  test('follows a big jump without sticking to the previous value', () => {
    const f = new OneEuroFilter();
    let t = 0;
    for (let i = 0; i < 30; i++) {
      t += 16;
      f.filter(0, t);
    }
    let last = 0;
    for (let i = 0; i < 30; i++) {
      t += 16;
      last = f.filter(100, t);
    }
    assert.ok(last > 90, `${last} should have caught up to the jump`);
  });
});
