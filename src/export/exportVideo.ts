import { ArrayBufferTarget, Muxer } from 'mp4-muxer';
import { lastContentFrame } from '../core/document';
import type { Engine } from '../gl/engine';

/**
 * Local export to .mp4 (task 2.4): every frame is composited by the same
 * renderer the canvas uses, read back, stamped with the watermark if the
 * plan calls for it, encoded to H.264 with WebCodecs, and muxed into an MP4
 * in memory.
 *
 * Deliberately WebCodecs + `mp4-muxer` inside the webview rather than a
 * native AVAssetWriter plugin (which is what tasks.json originally said):
 * it's the only route that can be verified end to end without a device
 * (headless Chromium encodes H.264 too), and it needs no new native code.
 * The cost is that WKWebView only gained `VideoEncoder` in iOS 16.4 while
 * the project's deployment target is 15.0 — `canExportVideo()` lets the UI
 * say so instead of failing mysteriously.
 */

export interface ExportOptions {
  /** Stamp "Clumsyloop" in the corner — the free plan. */
  watermark: boolean;
  onProgress?: (done: number, total: number) => void;
}

export function canExportVideo(): boolean {
  return typeof VideoEncoder !== 'undefined' && typeof VideoFrame !== 'undefined';
}

// High profile, level 5.1: the highest level, so any project size and fps
// the app allows stays inside it. Baseline is the fallback for encoders
// that refuse High.
const CODEC_CANDIDATES = ['avc1.640033', 'avc1.4d0033', 'avc1.420033'];

async function pickCodec(width: number, height: number, framerate: number, bitrate: number): Promise<string> {
  for (const codec of CODEC_CANDIDATES) {
    const { supported } = await VideoEncoder.isConfigSupported({ codec, width, height, framerate, bitrate });
    if (supported) return codec;
  }
  throw new Error('This device cannot encode H.264 video.');
}

function drawWatermark(ctx: CanvasRenderingContext2D, width: number, height: number) {
  const size = Math.max(12, Math.round(width * 0.05));
  const margin = Math.round(size * 0.8);
  ctx.save();
  ctx.font = `700 ${size}px -apple-system, 'Segoe UI', Roboto, sans-serif`;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'bottom';
  ctx.shadowColor = 'rgba(0, 0, 0, 0.6)';
  ctx.shadowBlur = size * 0.2;
  ctx.fillStyle = 'rgba(255, 255, 255, 0.8)';
  ctx.fillText('Clumsyloop', width - margin, height - margin);
  ctx.restore();
}

/** Renders frames 0..`lastContentFrame` and returns the finished MP4. */
export async function exportVideo(engine: Engine, { watermark, onProgress }: ExportOptions): Promise<Blob> {
  if (!canExportVideo()) throw new Error('Video export needs iOS 16.4 or newer.');
  const { doc, renderer } = engine;
  const fps = doc.fps;
  // H.264 needs even dimensions.
  const width = doc.width & ~1;
  const height = doc.height & ~1;
  const total = lastContentFrame(doc) + 1;
  const bitrate = Math.min(20_000_000, Math.max(1_000_000, Math.round(width * height * fps * 0.1)));
  const codec = await pickCodec(width, height, fps, bitrate);

  const target = new ArrayBufferTarget();
  const muxer = new Muxer({ target, video: { codec: 'avc', width, height, frameRate: fps }, fastStart: 'in-memory' });
  let encodeError: Error | null = null;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (e) => {
      encodeError = e;
    },
  });
  encoder.configure({ codec, width, height, bitrate, framerate: fps });

  const staging = document.createElement('canvas');
  staging.width = doc.width;
  staging.height = doc.height;
  const stagingCtx = staging.getContext('2d')!;
  const out = document.createElement('canvas');
  out.width = width;
  out.height = height;
  const ctx = out.getContext('2d')!;
  const paper = doc.paper;
  const paperCss = `rgb(${Math.round(paper.r * 255)}, ${Math.round(paper.g * 255)}, ${Math.round(paper.b * 255)})`;
  const frameDuration = 1_000_000 / fps;

  try {
    for (let f = 0; f < total; f++) {
      if (encodeError) throw encodeError;
      // Render and read back in one synchronous stretch: the composite
      // lives in a shared scratch surface that any other render reuses.
      stagingCtx.putImageData(renderer.toImageData(renderer.renderDocumentFrame(doc, f)), 0, 0);
      // Always opaque: video has no alpha, so transparent areas land on paper.
      ctx.fillStyle = paperCss;
      ctx.fillRect(0, 0, width, height);
      ctx.drawImage(staging, 0, 0);
      if (watermark) drawWatermark(ctx, width, height);

      const frame = new VideoFrame(out, { timestamp: Math.round(f * frameDuration), duration: Math.round(frameDuration) });
      encoder.encode(frame, { keyFrame: f % (fps * 2) === 0 });
      frame.close();
      onProgress?.(f + 1, total);
      // Backpressure + let the progress UI paint.
      while (encoder.encodeQueueSize > 4) await new Promise((r) => setTimeout(r, 4));
      await new Promise((r) => setTimeout(r, 0));
    }
    await encoder.flush();
    if (encodeError) throw encodeError;
  } finally {
    if (encoder.state !== 'closed') encoder.close();
  }
  muxer.finalize();
  return new Blob([target.buffer], { type: 'video/mp4' });
}

/** Hands the finished file to the user: the share sheet where the platform
 *  offers one for files (iOS: Save Video, AirDrop, Messages…), otherwise a
 *  plain download — `<a download>` does nothing inside WKWebView, which is
 *  why the share sheet is tried first. */
export async function deliverVideo(blob: Blob, filename: string): Promise<void> {
  const file = new File([blob], filename, { type: 'video/mp4' });
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
      return;
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return; // user dismissed the sheet
      // Anything else: fall through to the download.
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
