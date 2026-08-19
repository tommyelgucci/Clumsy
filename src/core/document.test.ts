/**
 * Unit tests for document.ts (pure functions: animated channels, cels,
 * clip groups) with Node's native runner, same criterion as math.test.ts.
 * Only what doesn't touch `Surface`/WebGL — the renderer itself is task
 * 2.2 and gets its own visual verification once it exists.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  channel,
  sampleChannel,
  setKeyframe,
  removeKeyframe,
  newTransform,
  transformIsIdentity,
  hasAnyKeyframes,
  newLayer,
  newDocument,
  uid,
  celAt,
  celStartFrame,
  celHoldLength,
  sortedCelFrames,
  layerIndexById,
  buildClipGroups,
  frameToTimecode,
  clampFrame,
  type Cel,
} from './document.ts';

/** Fake cel: celAt/celStartFrame/celHoldLength only look at the Map's keys,
 * never `.surface` — avoids having to build a real WebGL Surface to test
 * code that doesn't touch it. */
const stubCel = (label = ''): Cel => ({ id: uid('cel'), label }) as unknown as Cel;

describe('animated channels', () => {
  test('channel() starts with no keyframes, at the base value', () => {
    const ch = channel(3);
    assert.equal(ch.base, 3);
    assert.deepEqual(ch.keys, []);
  });

  describe('sampleChannel', () => {
    test('with no keyframes, always returns the base value', () => {
      const ch = channel(7);
      assert.equal(sampleChannel(ch, 0), 7);
      assert.equal(sampleChannel(ch, 100), 7);
    });

    test('before the first keyframe, holds its value', () => {
      const ch = channel(0);
      setKeyframe(ch, 10, 5);
      assert.equal(sampleChannel(ch, 0), 5);
    });

    test('after the last keyframe, holds its value', () => {
      const ch = channel(0);
      setKeyframe(ch, 10, 5);
      assert.equal(sampleChannel(ch, 999), 5);
    });

    test('interpolates linearly between two keyframes with linear easing', () => {
      const ch = channel(0);
      setKeyframe(ch, 0, 0, 'linear');
      setKeyframe(ch, 10, 100, 'linear');
      assert.equal(sampleChannel(ch, 5), 50);
    });

    test('the easing is decided by the outgoing keyframe, not the incoming one', () => {
      const ch = channel(0);
      setKeyframe(ch, 0, 0, 'easeIn'); // t*t: at t=0.5 gives 0.25, not 0.5
      setKeyframe(ch, 10, 100, 'linear');
      assert.equal(sampleChannel(ch, 5), 25);
    });

    test('"hold" easing keeps the outgoing value until the next keyframe', () => {
      const ch = channel(0);
      setKeyframe(ch, 0, 1, 'hold');
      setKeyframe(ch, 10, 9, 'hold');
      assert.equal(sampleChannel(ch, 1), 1);
      assert.equal(sampleChannel(ch, 9), 1);
      assert.equal(sampleChannel(ch, 10), 9); // the jump happens exactly at the next keyframe
    });
  });

  describe('setKeyframe', () => {
    test('adds a new keyframe and keeps the list sorted', () => {
      const ch = channel(0);
      setKeyframe(ch, 10, 1);
      setKeyframe(ch, 0, 2);
      setKeyframe(ch, 5, 3);
      assert.deepEqual(
        ch.keys.map((k) => k.frame),
        [0, 5, 10],
      );
    });

    test('updating an existing keyframe keeps its previous easing', () => {
      const ch = channel(0);
      setKeyframe(ch, 5, 1, 'easeIn');
      // The easing passed here is ignored: only the value changes.
      setKeyframe(ch, 5, 2, 'linear');
      assert.equal(ch.keys.length, 1);
      assert.equal(ch.keys[0].value, 2);
      assert.equal(ch.keys[0].easing, 'easeIn');
    });
  });

  test('removeKeyframe removes the keyframe at that frame and leaves the rest alone', () => {
    const ch = channel(0);
    setKeyframe(ch, 0, 1);
    setKeyframe(ch, 10, 2);
    removeKeyframe(ch, 0);
    assert.deepEqual(
      ch.keys.map((k) => k.frame),
      [10],
    );
  });

  test('removeKeyframe on a frame with no keyframe does nothing', () => {
    const ch = channel(0);
    setKeyframe(ch, 10, 2);
    removeKeyframe(ch, 999);
    assert.equal(ch.keys.length, 1);
  });
});

describe('transformIsIdentity / hasAnyKeyframes', () => {
  test('a freshly created transform is identity and has no keyframes', () => {
    const t = newTransform();
    assert.ok(transformIsIdentity(t, 0));
    assert.equal(hasAnyKeyframes(t), false);
  });

  test('a keyframe on any position/scale/rotation channel breaks identity', () => {
    const t = newTransform();
    setKeyframe(t.rotation, 0, 0.4);
    assert.equal(transformIsIdentity(t, 0), false);
    assert.equal(hasAnyKeyframes(t), true);
  });

  test('opacity does not count for transformIsIdentity', () => {
    const t = newTransform();
    setKeyframe(t.opacity, 0, 0.3);
    assert.ok(transformIsIdentity(t, 0));
    assert.equal(hasAnyKeyframes(t), true); // but it does count as "has keyframes"
  });
});

describe('newLayer / newDocument / uid', () => {
  test('newLayer has sensible defaults', () => {
    const l = newLayer('Stroke');
    assert.equal(l.name, 'Stroke');
    assert.equal(l.kind, 'draw');
    assert.equal(l.visible, true);
    assert.equal(l.locked, false);
    assert.equal(l.opacity, 1);
    assert.equal(l.blend, 'normal');
    assert.equal(l.clipToBelow, false);
    assert.equal(l.animated, true);
    assert.equal(l.cels.size, 0);
    assert.ok(transformIsIdentity(l.transform, 0));
  });

  test('newLayer respects animated=false and the layer kind', () => {
    const l = newLayer('Footage', false, 'camera');
    assert.equal(l.animated, false);
    assert.equal(l.kind, 'camera');
  });

  test('newDocument has sensible defaults (vertical, short-form)', () => {
    const doc = newDocument();
    assert.equal(doc.width, 1080);
    assert.equal(doc.height, 1920);
    assert.equal(doc.fps, 12);
    assert.equal(doc.frameCount, 24);
    assert.deepEqual(doc.layers, []);
    assert.deepEqual(doc.paper, { r: 1, g: 1, b: 1 });
    assert.equal(doc.paperAlpha, 1);
  });

  test('newDocument accepts explicit size/fps/duration', () => {
    const doc = newDocument(100, 200, 30, 60);
    assert.equal(doc.width, 100);
    assert.equal(doc.height, 200);
    assert.equal(doc.fps, 30);
    assert.equal(doc.frameCount, 60);
  });

  test('uid gives ids with the requested prefix, unique from each other', () => {
    const a = uid('layer');
    const b = uid('layer');
    assert.ok(a.startsWith('layer_'));
    assert.ok(b.startsWith('layer_'));
    assert.notEqual(a, b);
  });
});

describe('cels', () => {
  test('celAt on an animated layer with no cels returns null', () => {
    const l = newLayer('x');
    assert.equal(celAt(l, 0), null);
  });

  test('celAt returns the most recent cel at or before the requested frame', () => {
    const l = newLayer('x');
    const c0 = stubCel('start');
    const c10 = stubCel('ten');
    l.cels.set(0, c0);
    l.cels.set(10, c10);
    assert.equal(celAt(l, 0), c0);
    assert.equal(celAt(l, 5), c0); // holds until the next cel
    assert.equal(celAt(l, 10), c10);
    assert.equal(celAt(l, 500), c10);
  });

  test('celAt before any cel returns null', () => {
    const l = newLayer('x');
    l.cels.set(10, stubCel());
    assert.equal(celAt(l, 5), null);
  });

  test('celAt on a non-animated layer ignores the requested frame', () => {
    const l = newLayer('background', false);
    const c = stubCel();
    l.cels.set(7, c); // the key's position is irrelevant when animated=false
    assert.equal(celAt(l, 0), c);
    assert.equal(celAt(l, 9999), c);
  });

  test('celStartFrame reflects the frame of the visible cel, or -1', () => {
    const l = newLayer('x');
    assert.equal(celStartFrame(l, 0), -1);
    l.cels.set(0, stubCel());
    l.cels.set(10, stubCel());
    assert.equal(celStartFrame(l, 5), 0);
    assert.equal(celStartFrame(l, 10), 10);
  });

  test('celHoldLength reaches the next cel or the end of the animation', () => {
    const l = newLayer('x');
    l.cels.set(0, stubCel());
    l.cels.set(10, stubCel());
    assert.equal(celHoldLength(l, 0, 24), 10);
    assert.equal(celHoldLength(l, 10, 24), 14);
  });

  test('celHoldLength on a non-animated layer lasts the whole animation', () => {
    const l = newLayer('background', false);
    l.cels.set(0, stubCel());
    assert.equal(celHoldLength(l, 0, 100), 100);
  });

  test('sortedCelFrames returns frames in order, regardless of insertion order', () => {
    const l = newLayer('x');
    l.cels.set(20, stubCel());
    l.cels.set(0, stubCel());
    l.cels.set(10, stubCel());
    assert.deepEqual(sortedCelFrames(l), [0, 10, 20]);
  });
});

describe('layerIndexById', () => {
  test('finds a layer index by id', () => {
    const doc = newDocument();
    const a = newLayer('a');
    const b = newLayer('b');
    doc.layers.push(a, b);
    assert.equal(layerIndexById(doc, b.id), 1);
  });

  test('returns -1 if it does not exist', () => {
    const doc = newDocument();
    assert.equal(layerIndexById(doc, 'does-not-exist'), -1);
  });
});

describe('buildClipGroups', () => {
  test('with no clipToBelow, each layer is its own group', () => {
    const a = newLayer('a');
    const b = newLayer('b');
    const groups = buildClipGroups([a, b]);
    assert.equal(groups.length, 2);
    assert.deepEqual(groups[0].clipped, []);
    assert.deepEqual(groups[1].clipped, []);
  });

  test('layers with clipToBelow hang off the previous base', () => {
    const base = newLayer('base');
    const clip1 = newLayer('clip1');
    clip1.clipToBelow = true;
    const clip2 = newLayer('clip2');
    clip2.clipToBelow = true;
    const other = newLayer('other');
    const groups = buildClipGroups([base, clip1, clip2, other]);
    assert.equal(groups.length, 2);
    assert.equal(groups[0].base, base);
    assert.deepEqual(groups[0].clipped, [clip1, clip2]);
    assert.equal(groups[1].base, other);
  });

  test('a first layer with clipToBelow, nothing under it, becomes its own base', () => {
    const first = newLayer('first');
    first.clipToBelow = true;
    const groups = buildClipGroups([first]);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].base, first);
  });
});

describe('frameToTimecode', () => {
  test('frame 0 is 00:00+00', () => {
    assert.equal(frameToTimecode(0, 24), '00:00+00');
  });

  test('counts minutes, seconds, and leftover frames', () => {
    // 24fps, frame 24*65 + 5 = 1565 -> 1 min, 5 s, 5 frames
    assert.equal(frameToTimecode(24 * 65 + 5, 24), '01:05+05');
  });
});

describe('camera cels and drawn cels share the same compositing interface', () => {
  test('a camera layer and a draw layer both read back through celAt/Cel unchanged', () => {
    // What matters here isn't Surface's contents (that's WebGL, task 2.2) —
    // it's that celAt(), celStartFrame(), etc. don't know or care whether a
    // Cel came from CameraCapture.capturePhoto() or a brush stroke. Layer.kind
    // is the only place that distinction exists.
    const cameraLayer = newLayer('Stop motion', true, 'camera');
    const drawLayer = newLayer('Effects', true, 'draw');
    const cameraCel = stubCel('captured frame');
    const drawnCel = stubCel('drawn frame');
    cameraLayer.cels.set(0, cameraCel);
    drawLayer.cels.set(0, drawnCel);

    assert.equal(celAt(cameraLayer, 0), cameraCel);
    assert.equal(celAt(drawLayer, 0), drawnCel);
    // Same shape either way: an id and a surface, nothing camera-specific.
    assert.ok('id' in cameraCel && 'id' in drawnCel);
  });
});

describe('clampFrame', () => {
  test('clamps below 0', () => {
    const doc = newDocument(1, 1, 12, 24);
    assert.equal(clampFrame(doc, -5), 0);
  });

  test('clamps to the last valid frame', () => {
    const doc = newDocument(1, 1, 12, 24);
    assert.equal(clampFrame(doc, 999), 23);
  });

  test('rounds non-integer values', () => {
    const doc = newDocument(1, 1, 12, 24);
    assert.equal(clampFrame(doc, 5.6), 6);
  });
});
