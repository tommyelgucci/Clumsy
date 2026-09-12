/**
 * Unit tests for io.ts's pure half: document metadata (de)serialization
 * and PNG encode/decode — no `Surface`, no WebGL, no DOM. The GPU-facing
 * glue (`gl/projectIO.ts`) and the IndexedDB backend
 * (`storage/projectStore.ts`) get their own browser-based verification,
 * same reasoning as document.test.ts deferring `Surface` to task 2.2.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { newDocument, newLayer, setKeyframe, uid } from './document';
import { decodeCelPixels, encodeCelPixels, deserializeDocumentMeta, serializeDocumentMeta } from './io';

describe('serializeDocumentMeta / deserializeDocumentMeta', () => {
  test('round-trips document-level metadata exactly', () => {
    const doc = newDocument(360, 640, 12, 48);
    doc.name = 'My clip';
    doc.paperAlpha = 0.5;

    const meta = serializeDocumentMeta(doc);
    const { doc: restored } = deserializeDocumentMeta(meta);

    assert.equal(restored.id, doc.id);
    assert.equal(restored.name, 'My clip');
    assert.equal(restored.width, 360);
    assert.equal(restored.height, 640);
    assert.equal(restored.fps, 12);
    assert.equal(restored.frameCount, 48);
    assert.deepEqual(restored.paper, doc.paper);
    assert.equal(restored.paperAlpha, 0.5);
    assert.equal(restored.createdAt, doc.createdAt);
    assert.equal(restored.modifiedAt, doc.modifiedAt);
  });

  test('round-trips layer properties, including a non-default blend/clip/lock combination', () => {
    const doc = newDocument();
    const layer = newLayer('Ink', true, 'draw');
    layer.opacity = 0.7;
    layer.blend = 'multiply';
    layer.clipToBelow = true;
    layer.alphaLock = true;
    layer.locked = true;
    layer.visible = false;
    doc.layers.push(layer);

    const { doc: restored } = deserializeDocumentMeta(serializeDocumentMeta(doc));
    const restoredLayer = restored.layers[0];

    assert.equal(restoredLayer.id, layer.id);
    assert.equal(restoredLayer.name, 'Ink');
    assert.equal(restoredLayer.kind, 'draw');
    assert.equal(restoredLayer.opacity, 0.7);
    assert.equal(restoredLayer.blend, 'multiply');
    assert.equal(restoredLayer.clipToBelow, true);
    assert.equal(restoredLayer.alphaLock, true);
    assert.equal(restoredLayer.locked, true);
    assert.equal(restoredLayer.visible, false);
  });

  test('round-trips transform keyframes', () => {
    const doc = newDocument();
    const layer = newLayer('Bubble');
    setKeyframe(layer.transform.x, 0, 10, 'linear');
    setKeyframe(layer.transform.x, 12, 100, 'easeOut');
    setKeyframe(layer.transform.opacity, 0, 0, 'hold');
    doc.layers.push(layer);

    const { doc: restored } = deserializeDocumentMeta(serializeDocumentMeta(doc));
    assert.deepEqual(restored.layers[0].transform.x.keys, layer.transform.x.keys);
    assert.deepEqual(restored.layers[0].transform.opacity.keys, layer.transform.opacity.keys);
  });

  test('cel placements come back flattened, with no Surface attached', () => {
    const doc = newDocument();
    const camera = newLayer('Stop motion', true, 'camera');
    // stubCel-style: celAt/placement logic never touches `.surface`.
    camera.cels.set(0, { id: uid('cel'), surface: null as never, label: 'Take 1' });
    camera.cels.set(5, { id: uid('cel'), surface: null as never });
    doc.layers.push(camera);

    const meta = serializeDocumentMeta(doc);
    const { doc: restored, placements } = deserializeDocumentMeta(meta);

    assert.equal(restored.layers[0].cels.size, 0, 'cels start empty — gl/projectIO.ts fills them in');
    assert.equal(placements.length, 2);
    assert.deepEqual(
      placements.map((p) => p.frame),
      [0, 5],
    );
    assert.equal(placements[0].label, 'Take 1');
    assert.equal(placements[1].label, undefined);
    assert.equal(placements[0].layerId, camera.id);
  });

  test('two layers keep their cels attributed to the right layer', () => {
    const doc = newDocument();
    const camera = newLayer('Camera', true, 'camera');
    const ink = newLayer('Ink', true, 'draw');
    camera.cels.set(0, { id: 'cam-cel', surface: null as never });
    ink.cels.set(0, { id: 'ink-cel', surface: null as never });
    doc.layers.push(camera, ink);

    const { placements } = deserializeDocumentMeta(serializeDocumentMeta(doc));
    const camPlacement = placements.find((p) => p.celId === 'cam-cel')!;
    const inkPlacement = placements.find((p) => p.celId === 'ink-cel')!;
    assert.equal(camPlacement.layerId, camera.id);
    assert.equal(inkPlacement.layerId, ink.id);
  });
});

describe('encodeCelPixels / decodeCelPixels', () => {
  test('round-trips a small RGBA buffer exactly (lossless)', () => {
    const w = 4;
    const h = 3;
    const pixels = new Uint8Array(w * h * 4);
    for (let i = 0; i < pixels.length; i++) pixels[i] = (i * 37) % 256;

    const png = encodeCelPixels(w, h, pixels);
    const decoded = decodeCelPixels(png);

    assert.equal(decoded.width, w);
    assert.equal(decoded.height, h);
    assert.deepEqual(decoded.pixels, pixels);
  });

  test('round-trips fully transparent pixels (alpha 0 everywhere)', () => {
    const w = 2;
    const h = 2;
    const pixels = new Uint8Array(w * h * 4); // all zero: transparent black
    const decoded = decodeCelPixels(encodeCelPixels(w, h, pixels));
    assert.deepEqual(decoded.pixels, pixels);
  });

  test('round-trips a solid opaque color exactly', () => {
    const w = 8;
    const h = 8;
    const pixels = new Uint8Array(w * h * 4);
    for (let i = 0; i < pixels.length; i += 4) {
      pixels[i] = 12;
      pixels[i + 1] = 200;
      pixels[i + 2] = 77;
      pixels[i + 3] = 255;
    }
    const decoded = decodeCelPixels(encodeCelPixels(w, h, pixels));
    assert.deepEqual(decoded.pixels, pixels);
  });

  test('accepts a Uint8ClampedArray, as produced by ImageData / toImageData', () => {
    const w = 2;
    const h = 1;
    const pixels = new Uint8ClampedArray([10, 20, 30, 255, 40, 50, 60, 128]);
    const decoded = decodeCelPixels(encodeCelPixels(w, h, pixels));
    assert.deepEqual(decoded.pixels, new Uint8Array(pixels.buffer));
  });
});
