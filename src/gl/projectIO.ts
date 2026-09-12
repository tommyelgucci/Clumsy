/**
 * The GPU-facing half of local project persistence (task 2.5) — getting
 * pixels in and out of actual `Surface`s. `core/io.ts` is the pure half
 * (JSON metadata, PNG encode/decode); `storage/projectStore.ts` is the
 * IndexedDB backend. This file is the glue between them and the
 * `Renderer`, which is why it lives in `gl/` and not `core/` — same
 * boundary `renderer.ts` itself documents ("gl/ is the sole point of
 * contact with WebGL").
 */
import {
  decodeCelPixels,
  deserializeDocumentMeta,
  encodeCelPixels,
  serializeDocumentMeta,
  type SerializedDocument,
} from '../core/io';
import type { ClumsyloopDocument } from '../core/document';
import { Renderer } from './renderer';

/** A project ready to hand to `storage/projectStore.ts`: JSON-safe
 *  metadata plus one PNG per non-empty cel, keyed by `celId`. */
export interface CapturedProject {
  meta: SerializedDocument;
  cels: Map<string, Uint8Array>;
}

/** Reads every non-empty cel's pixels back off the GPU and encodes them,
 *  alongside the document's metadata — the save half of task 2.5. Empty
 *  cels (a layer's placeholder before its first capture/stroke) are
 *  skipped: nothing to encode, and `restoreProject` already leaves an
 *  unlisted cel's surface freshly cleared. */
export function captureProject(renderer: Renderer, doc: ClumsyloopDocument): CapturedProject {
  const meta = serializeDocumentMeta(doc);
  const cels = new Map<string, Uint8Array>();
  for (const layer of doc.layers) {
    for (const cel of layer.cels.values()) {
      if (cel.surface.empty) continue;
      const image = renderer.toImageData(cel.surface);
      cels.set(cel.id, encodeCelPixels(image.width, image.height, image.data));
    }
  }
  return { meta, cels };
}

/**
 * Rebuilds a full `ClumsyloopDocument` — every cel with a real, uploaded
 * `Surface` — from saved metadata and PNGs. The load half of task 2.5.
 *
 * `renderer.setDocumentSize` must already match `meta.width`/`meta.height`
 * before calling this (same precondition `Renderer.createSurface` always
 * has) — the caller almost always just made the renderer for this
 * project, so it's simplest to require the size be set once, explicitly,
 * rather than have this function silently resize the renderer as a side
 * effect of loading.
 */
export function restoreProject(renderer: Renderer, project: CapturedProject): ClumsyloopDocument {
  const { doc, placements } = deserializeDocumentMeta(project.meta);
  const layerById = new Map(doc.layers.map((l) => [l.id, l]));

  for (const placement of placements) {
    const layer = layerById.get(placement.layerId);
    if (!layer) continue; // Shouldn't happen — placements come from doc.layers itself.
    const pngBytes = project.cels.get(placement.celId);
    const surface = renderer.createSurface(placement.celId);
    if (pngBytes) {
      const decoded = decodeCelPixels(pngBytes);
      renderer.uploadPixels(surface, decoded.width, decoded.height, decoded.pixels);
    }
    // No PNG for this placement means the cel was empty when saved
    // (`captureProject` skips those) — `surface` stays freshly cleared,
    // matching what it looked like before the save.
    layer.cels.set(placement.frame, { id: placement.celId, surface, label: placement.label });
  }

  return doc;
}
