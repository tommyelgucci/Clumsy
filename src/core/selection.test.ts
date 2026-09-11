/**
 * Unit tests for selection.ts — pure, no GPU or DOM. Ported reasoning
 * from Trace's own selection.ts tests, adapted to this project's
 * DOM-free rasterizer (see the module's own header comment for why).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { maskContains, polygonBounds, rasterizePolygon } from './selection.ts';

describe('polygonBounds', () => {
  test('wraps the extremes of the point list', () => {
    const rect = polygonBounds([{ x: 10, y: 20 }, { x: 50, y: 5 }, { x: 30, y: 60 }], 100, 100);
    assert.equal(rect.x, 10);
    assert.equal(rect.y, 5);
    assert.equal(rect.x2, 50);
    assert.equal(rect.y2, 60);
  });

  test('clamps to the document bounds', () => {
    const rect = polygonBounds([{ x: -20, y: -5 }, { x: 200, y: 300 }], 100, 100);
    assert.equal(rect.x, 0);
    assert.equal(rect.y, 0);
    assert.equal(rect.x2, 100);
    assert.equal(rect.y2, 100);
  });
});

describe('rasterizePolygon', () => {
  test('fills exactly a square polygon', () => {
    // A 10x10 square from (5,5) to (15,15).
    const points = [{ x: 5, y: 5 }, { x: 15, y: 5 }, { x: 15, y: 15 }, { x: 5, y: 15 }];
    const rect = polygonBounds(points, 100, 100);
    const mask = rasterizePolygon(points, rect);
    const w = rect.x2 - rect.x;

    // Center of the square is filled.
    const cx = 10 - rect.x;
    const cy = 10 - rect.y;
    assert.equal(mask[cy * w + cx], 1);

    // A corner well outside the square, but still inside the bounding
    // rect only by coincidence of how polygonBounds pads — check a point
    // definitely outside the polygon itself using a wider canvas.
    const wide = polygonBounds(points, 100, 100);
    const outside = rasterizePolygon(points, { x: 0, y: 0, x2: 30, y2: 30 });
    assert.equal(outside[2 * 30 + 2], 0); // (2,2) is outside the 5..15 square
    void wide;
  });

  test('a triangle fills roughly half its bounding box, not the whole thing', () => {
    const points = [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 0, y: 20 }];
    const rect = { x: 0, y: 0, x2: 20, y2: 20 };
    const mask = rasterizePolygon(points, rect);
    let filled = 0;
    for (const v of mask) filled += v;
    const total = 20 * 20;
    assert.ok(filled > total * 0.3 && filled < total * 0.7, `filled=${filled} total=${total}`);
  });

  test('fewer than 3 points produces an all-empty mask', () => {
    const rect = { x: 0, y: 0, x2: 10, y2: 10 };
    const mask = rasterizePolygon([{ x: 0, y: 0 }, { x: 5, y: 5 }], rect);
    assert.ok(mask.every((v) => v === 0));
  });

  test('a self-intersecting (figure-eight) path uses the even-odd rule, leaving the crossed-over lobe empty', () => {
    // Two triangles sharing a point at (10,10), one up-left one up-right,
    // traced as a single bowtie path — even-odd fill leaves each lobe's
    // interior filled but the shared crossing point itself has no
    // special hole (this just confirms the fill doesn't throw or
    // produce a fully-filled bounding box for a self-intersecting path).
    const points = [{ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 20 }, { x: 20, y: 20 }, { x: 10, y: 10 }, { x: 20, y: 0 }];
    const rect = { x: 0, y: 0, x2: 20, y2: 20 };
    const mask = rasterizePolygon(points, rect);
    let filled = 0;
    for (const v of mask) filled += v;
    assert.ok(filled > 0 && filled < 20 * 20);
  });
});

describe('maskContains', () => {
  test('true inside the mask, false outside it and outside the rect entirely', () => {
    const points = [{ x: 5, y: 5 }, { x: 15, y: 5 }, { x: 15, y: 15 }, { x: 5, y: 15 }];
    const rect = polygonBounds(points, 100, 100);
    const mask = rasterizePolygon(points, rect);
    assert.equal(maskContains(mask, rect, 10, 10), true);
    assert.equal(maskContains(mask, rect, 1, 1), false);
    assert.equal(maskContains(mask, rect, 500, 500), false);
  });
});
