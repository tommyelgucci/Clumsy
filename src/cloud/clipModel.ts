/**
 * Pure model for published clips, reports, and blocks (tasks 4.1-4.4, 5.1):
 * the rules every one of them shares with `firestore.rules`, kept free of
 * Firebase imports so they run under plain `node --test` like `src/core/`.
 * `clips.ts` is the thin Firebase layer on top.
 */

/** Caption cap. Mirrors `firestore.rules` (`caption.size() <= 200`). */
export const MAX_CAPTION_LENGTH = 200;

/** The app's hashtag, appended when a clip is shared outside the app. */
export const APP_HASHTAG = '#clumsyloop';

export interface ClipRecord {
  id: string;
  ownerId: string;
  videoUrl: string;
  storagePath: string;
  caption: string;
  /** Milliseconds since epoch (resolved from the server timestamp). */
  createdAtMs: number;
  width?: number;
  height?: number;
  fps?: number;
  frames?: number;
}

/** One line, trimmed, at most `MAX_CAPTION_LENGTH` UTF-16 units — the unit
 *  is deliberately the conservative one, so a caption this accepts can
 *  never be refused by the rules however they count characters. Never
 *  leaves half an emoji (a lone surrogate) at the cut. */
export function normalizeCaption(raw: string): string {
  const oneLine = raw.replace(/\s+/g, ' ').trim();
  let out = '';
  for (const ch of oneLine) {
    if (out.length + ch.length > MAX_CAPTION_LENGTH) break;
    out += ch;
  }
  return out.trimEnd();
}

/** The caption plus the app hashtag, for the share sheet. */
export function shareCaption(caption: string): string {
  const c = normalizeCaption(caption);
  return c ? `${c} ${APP_HASHTAG}` : APP_HASHTAG;
}

/** Where a clip's video lives. Ownership is in the path, which is what
 *  `storage.rules` and `firestore.rules` both key on. */
export function clipStoragePath(ownerId: string, clipId: string): string {
  return `clips/${ownerId}/${clipId}`;
}

export interface NewClipInput {
  ownerId: string;
  clipId: string;
  videoUrl: string;
  caption: string;
  width: number;
  height: number;
  fps: number;
  frames: number;
}

/** The fields of a new `clips/{clipId}` document, minus `createdAt` (the
 *  caller supplies the server timestamp). Exactly the set `firestore.rules`
 *  allows — an extra field here would be refused there. */
export function buildClipFields(input: NewClipInput) {
  const fields: Record<string, string | number | boolean> = {
    ownerId: input.ownerId,
    storagePath: clipStoragePath(input.ownerId, input.clipId),
    videoUrl: input.videoUrl,
    hidden: false,
    width: input.width,
    height: input.height,
    fps: input.fps,
    frames: input.frames,
  };
  const caption = normalizeCaption(input.caption);
  if (caption) fields.caption = caption;
  return fields;
}

/** Drops clips by authors the viewer has blocked. Done client-side because
 *  Firestore can't express "not in a list this long" in a query. */
export function filterBlocked<T extends { ownerId: string }>(clips: T[], blockedIds: ReadonlySet<string>): T[] {
  if (blockedIds.size === 0) return clips;
  return clips.filter((c) => !blockedIds.has(c.ownerId));
}

export const REPORT_REASONS = [
  { id: 'inappropriate', label: 'Inappropriate or explicit' },
  { id: 'harassment', label: 'Harassment or hate' },
  { id: 'spam', label: 'Spam' },
  { id: 'copyright', label: 'Copyright' },
  { id: 'other', label: 'Something else' },
] as const;

export type ReportReason = (typeof REPORT_REASONS)[number]['id'];

export function isReportReason(value: string): value is ReportReason {
  return REPORT_REASONS.some((r) => r.id === value);
}

/** One report per (reporter, clip): the deterministic id makes a repeat a
 *  refused duplicate write instead of a second document, so one person
 *  re-reporting can't inflate the count the moderation function reads. */
export function reportDocId(clipId: string, reporterId: string): string {
  return `${clipId}_${reporterId}`;
}
