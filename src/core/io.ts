/**
 * Local project persistence (task 2.5) — the pure half.
 *
 * Split in two, on purpose, matching CLAUDE.md's "gl/ is the sole point
 * of contact with WebGL": this module never touches a `Surface` or a
 * `Renderer`, only JSON-safe metadata and raw pixel bytes, so it runs
 * (and gets tested) under plain Node — no WebGL, no DOM, no browser.
 * `gl/projectIO.ts` is the other half: it owns getting pixels in and out
 * of actual GPU surfaces and calls into this module to encode/decode
 * them. `storage/projectStore.ts` is the third half — IndexedDB, which
 * this module doesn't touch either.
 *
 * PNG encode/decode uses `upng-js` instead of the `canvas.toBlob()` path
 * Trace's `io.ts` uses — deliberately, not just for parity: a DOM canvas
 * doesn't exist under Node's test runner, and `upng-js` operates on raw
 * `ArrayBuffer`s, so this file can have real `npm test` coverage instead
 * of being another "only verified in a browser" surface. Already flagged
 * as the library to reach for here, in RUMBO.md's known-debts note.
 *
 * Ported and trimmed hard from Trace's `io.ts` (1100+ lines): no bone
 * rigs/meshes, no sprite-swap variants, no layer masks, no text/
 * adjustment layers, no audio track, no custom brush textures, no
 * history persistence, no zip container. Task 2.5's acceptance criteria
 * is "frame by frame, exactly as it was" for frames + layers + metadata
 * — undo history surviving a restart isn't part of that, and Clumsyloop
 * doesn't even have a `historyOps.ts` equivalent to serialize it with.
 * No zip either: IndexedDB is already a real multi-record key-value
 * store (see `storage/projectStore.ts`), so packing everything into one
 * archive file the way Trace's downloadable `.trace` format needs would
 * just be work with no payoff — v1 has no "export/share the project
 * file" feature (see CLAUDE.md, "v1 scope").
 */
import UPNG from 'upng-js';
import { newTransform, type ClumsyloopDocument, type Layer, type LayerKind, type TransformTrack } from './document';
import type { BlendMode, RGB } from './types';

// @types/upng-js@2.1.5 only declares encode's first 5 params, but the
// actual upng-js@2.1.0 runtime takes a 6th, `forbidPlte` — needed below
// to work around a real decode bug in this library version (see
// `encodeCelPixels`). Narrow local cast instead of an `any` import so
// the rest of this file still gets the real types.
const encodePNG = UPNG.encode as (
  imgs: ArrayBuffer[],
  w: number,
  h: number,
  cnum: number,
  dels: number[] | undefined,
  forbidPlte: boolean,
) => ArrayBuffer;

export const PROJECT_FORMAT_VERSION = 1;

interface SerializedCelRef {
  frame: number;
  celId: string;
  label?: string;
}

interface SerializedLayer {
  id: string;
  name: string;
  kind: LayerKind;
  visible: boolean;
  locked: boolean;
  opacity: number;
  blend: BlendMode;
  clipToBelow: boolean;
  alphaLock: boolean;
  animated: boolean;
  cels: SerializedCelRef[];
  transform: TransformTrack;
}

/** JSON-safe project metadata — no pixels, no `Surface`. Each cel's PNG
 *  bytes are stored separately, keyed by `celId` (see `storage/projectStore.ts`),
 *  the same way Trace keeps `cels/<id>.png` apart from `trace.json`. */
export interface SerializedDocument {
  version: number;
  id: string;
  name: string;
  width: number;
  height: number;
  fps: number;
  frameCount: number;
  paper: RGB;
  paperAlpha: number;
  createdAt: number;
  modifiedAt: number;
  layers: SerializedLayer[];
}

/** Every cel reference in `meta`, flattened — what `gl/projectIO.ts` walks
 *  to know which PNGs to decode and which layer/frame each belongs on. */
export interface CelPlacement {
  layerId: string;
  frame: number;
  celId: string;
  label?: string;
}

/** Strips every cel down to its id/frame/label — the pixels live in a
 *  separate PNG per cel, encoded by the caller (`encodeCelPixels` below)
 *  since getting pixels out of a `Surface` needs the renderer. */
export function serializeDocumentMeta(doc: ClumsyloopDocument): SerializedDocument {
  return {
    version: PROJECT_FORMAT_VERSION,
    id: doc.id,
    name: doc.name,
    width: doc.width,
    height: doc.height,
    fps: doc.fps,
    frameCount: doc.frameCount,
    paper: doc.paper,
    paperAlpha: doc.paperAlpha,
    createdAt: doc.createdAt,
    modifiedAt: doc.modifiedAt,
    layers: doc.layers.map((layer) => ({
      id: layer.id,
      name: layer.name,
      kind: layer.kind,
      visible: layer.visible,
      locked: layer.locked,
      opacity: layer.opacity,
      blend: layer.blend,
      clipToBelow: layer.clipToBelow,
      alphaLock: layer.alphaLock,
      animated: layer.animated,
      cels: [...layer.cels]
        .sort((a, b) => a[0] - b[0])
        .map(([frame, cel]) => ({ frame, celId: cel.id, label: cel.label })),
      transform: layer.transform,
    })),
  };
}

/**
 * Rebuilds the document's layers/transforms/cel placements from saved
 * metadata — with every `Layer.cels` map left EMPTY. There's no `Surface`
 * to put in a `Cel` here: this module never imports the renderer (see the
 * file header). `gl/projectIO.ts` decodes each cel's PNG, uploads it to a
 * real surface, and only then calls `layer.cels.set(frame, {id, surface, label})`
 * for each entry in the returned `CelPlacement[]`.
 */
export function deserializeDocumentMeta(meta: SerializedDocument): {
  doc: ClumsyloopDocument;
  placements: CelPlacement[];
} {
  const doc: ClumsyloopDocument = {
    id: meta.id,
    name: meta.name,
    width: meta.width,
    height: meta.height,
    fps: meta.fps,
    frameCount: meta.frameCount,
    layers: [],
    paper: meta.paper,
    paperAlpha: meta.paperAlpha,
    createdAt: meta.createdAt,
    modifiedAt: meta.modifiedAt,
  };

  const placements: CelPlacement[] = [];
  for (const sl of meta.layers) {
    const layer: Layer = {
      id: sl.id,
      name: sl.name,
      kind: sl.kind,
      visible: sl.visible,
      locked: sl.locked,
      opacity: sl.opacity,
      blend: sl.blend,
      clipToBelow: sl.clipToBelow,
      alphaLock: sl.alphaLock,
      animated: sl.animated,
      cels: new Map(),
      transform: sl.transform ?? newTransform(),
    };
    doc.layers.push(layer);
    for (const ref of sl.cels) {
      placements.push({ layerId: layer.id, frame: ref.frame, celId: ref.celId, label: ref.label });
    }
  }
  return { doc, placements };
}

/** A cel's pixels, decoded and ready to upload — straight (not
 *  premultiplied) alpha, matching what `Renderer.toImageData` produces
 *  and `Renderer.uploadPixels` expects. */
export interface DecodedCel {
  width: number;
  height: number;
  pixels: Uint8Array;
}

/** Encodes one cel's straight-alpha RGBA pixels as a lossless PNG.
 *  `cnum=0` disables palette quantization — a stop-motion project's
 *  linework has to round-trip exactly, not get requantized every save.
 *
 *  `forbidPlte: true` (encode's 6th argument) is load-bearing, not an
 *  optimization: with `cnum=0` but palette mode still allowed, `encode`
 *  auto-selects an indexed palette whenever a frame has ≤256 unique
 *  colors (small test fixtures, but just as easily a flat-colored drawn
 *  cel) — and this version of `upng-js`'s `decode`/`toRGBA8` crashes on
 *  its own palette output (`out.data` comes back `undefined`, a real bug
 *  in the library, confirmed against a plain encode/decode round trip
 *  with no slicing or wrapping involved). Forcing truecolor+alpha (ctype
 *  6) sidesteps the bug entirely and is what full-fidelity photo/ink
 *  content needs anyway. */
export function encodeCelPixels(width: number, height: number, pixels: Uint8Array | Uint8ClampedArray): Uint8Array {
  const buffer = pixels.buffer.slice(pixels.byteOffset, pixels.byteOffset + pixels.byteLength) as ArrayBuffer;
  return new Uint8Array(encodePNG([buffer], width, height, 0, undefined, true));
}

export function decodeCelPixels(bytes: Uint8Array): DecodedCel {
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const image = UPNG.decode(buffer);
  const [rgba] = UPNG.toRGBA8(image);
  return { width: image.width, height: image.height, pixels: new Uint8Array(rgba) };
}
