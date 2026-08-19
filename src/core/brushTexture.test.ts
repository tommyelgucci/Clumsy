import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  BUILTIN_TEXTURES,
  BRUSH_TEXTURE_SIZE,
  isBuiltinTextureId,
  generateBrushTexturePixels,
} from './brushTexture.ts';

describe('isBuiltinTextureId', () => {
  test('accepts every id listed in BUILTIN_TEXTURES', () => {
    for (const t of BUILTIN_TEXTURES) assert.ok(isBuiltinTextureId(t.id));
  });

  test('rejects an arbitrary string', () => {
    assert.equal(isBuiltinTextureId('not-a-real-texture'), false);
  });
});

describe('generateBrushTexturePixels', () => {
  test('returns an RGBA8 buffer of the requested size', () => {
    const size = 32;
    const buf = generateBrushTexturePixels('grain', size);
    assert.equal(buf.length, size * size * 4);
  });

  test('defaults to BRUSH_TEXTURE_SIZE when no size is given', () => {
    const buf = generateBrushTexturePixels('canvas');
    assert.equal(buf.length, BRUSH_TEXTURE_SIZE * BRUSH_TEXTURE_SIZE * 4);
  });

  test('is deterministic: the same id produces identical pixels every call', () => {
    const a = generateBrushTexturePixels('splatter', 24);
    const b = generateBrushTexturePixels('splatter', 24);
    assert.deepEqual(Array.from(a), Array.from(b));
  });

  test('different built-in ids produce different pixels', () => {
    const a = generateBrushTexturePixels('grain', 24);
    const b = generateBrushTexturePixels('chalk', 24);
    assert.notDeepEqual(Array.from(a), Array.from(b));
  });

  test('every built-in texture paints at least some coverage', () => {
    for (const t of BUILTIN_TEXTURES) {
      const buf = generateBrushTexturePixels(t.id, 32);
      let maxAlpha = 0;
      for (let i = 3; i < buf.length; i += 4) maxAlpha = Math.max(maxAlpha, buf[i]);
      assert.ok(maxAlpha > 0, `${t.id} produced an entirely transparent buffer`);
    }
  });
});
