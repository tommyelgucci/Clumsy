/**
 * Pure logic for the internal review panel (task 5.3) — no Firebase Admin
 * SDK, no Cloud Functions runtime, testable with plain Node like
 * moderation.ts. `reviewHandlers.ts` is the thin layer that reads and
 * writes Firestore/Storage around it.
 *
 * Why this exists: Apple's UGC guideline needs reported content acted on
 * within 24 hours. Reports are unreadable to clients and `hidden` is
 * writable only by Admin SDK code, so the panel can't talk to Firestore
 * directly — it goes through callable functions that check the caller is on
 * the admin list first.
 */

/** Apple's expectation for acting on a report. */
export const REVIEW_DEADLINE_MS = 24 * 60 * 60 * 1000;

export type ReviewDecision = 'restore' | 'delete';

/** A request the panel sent that doesn't make sense. */
export class InvalidReviewRequest extends Error {}

export function parseReviewRequest(data: unknown): { clipId: string; decision: ReviewDecision } {
  const d = (data ?? {}) as { clipId?: unknown; decision?: unknown };
  // A clip id becomes part of Firestore and Storage paths, so refuse
  // anything that could be read as a different path.
  if (typeof d.clipId !== 'string' || d.clipId.length === 0 || d.clipId.length > 200 || d.clipId.includes('/')) {
    throw new InvalidReviewRequest('clipId must be a non-empty string without "/"');
  }
  if (d.decision !== 'restore' && d.decision !== 'delete') {
    throw new InvalidReviewRequest('decision must be "restore" or "delete"');
  }
  return { clipId: d.clipId, decision: d.decision };
}

/** Where a clip's video must live: the owner's own prefix for this clip id —
 *  the shape `storage.rules` enforces on upload. Anything else in a clip
 *  document's `storagePath` is not something to delete on a moderator's say-so. */
export function isSafeStoragePath(path: unknown, ownerId: string, clipId: string): path is string {
  return typeof path === 'string' && path === `clips/${ownerId}/${clipId}`;
}

export interface ReportRow {
  clipId: string;
  reporterId: string;
  reason: string;
  createdAtMs: number;
}

export interface ClipRow {
  id: string;
  ownerId: string;
  caption: string;
  videoUrl: string;
  hidden: boolean;
  createdAtMs: number;
}

export interface QueueItem extends ClipRow {
  reports: { reporterId: string; reason: string; createdAtMs: number }[];
  oldestReportMs: number;
  /** When Apple's 24 hours run out for this clip. */
  dueAtMs: number;
}

/** The review queue: one entry per reported clip that still exists, most
 *  urgent (oldest report) first, so working from the top meets the deadline.
 *  Reports for a clip that's gone (deleted by its owner) drop out. */
export function buildQueue(reports: ReportRow[], clips: ReadonlyMap<string, ClipRow>): QueueItem[] {
  const byClip = new Map<string, ReportRow[]>();
  for (const r of reports) {
    const list = byClip.get(r.clipId);
    if (list) list.push(r);
    else byClip.set(r.clipId, [r]);
  }
  const items: QueueItem[] = [];
  for (const [clipId, rows] of byClip) {
    const clip = clips.get(clipId);
    if (!clip) continue;
    const sorted = [...rows].sort((a, b) => a.createdAtMs - b.createdAtMs);
    items.push({
      ...clip,
      reports: sorted.map(({ reporterId, reason, createdAtMs }) => ({ reporterId, reason, createdAtMs })),
      oldestReportMs: sorted[0].createdAtMs,
      dueAtMs: sorted[0].createdAtMs + REVIEW_DEADLINE_MS,
    });
  }
  return items.sort((a, b) => a.oldestReportMs - b.oldestReportMs);
}
