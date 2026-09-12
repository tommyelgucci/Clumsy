/**
 * Pure moderation logic (task 5.2) — no Firebase Admin SDK, no Cloud
 * Functions runtime, testable with plain Node the same way the main
 * app's own `src/core/` modules are. `index.ts`'s Firestore trigger is a
 * thin wrapper around this: it reads the report count from Firestore,
 * hands it to `shouldHideClip`, and only then decides whether to write
 * `hidden: true` with Admin SDK privileges.
 */

/** Start conservative, per CLAUDE.md/RUMBO.md's own note: one report is
 *  enough to hide a clip while it's under review, not to delete it
 *  outright — a human still makes the delete-or-restore call (task
 *  5.3's internal review panel). Exported as a named constant, not
 *  inlined, so the eventual review panel and any future tuning of this
 *  number have exactly one place to look. */
export const REPORT_THRESHOLD = 1;

/** Whether a clip with `reportCount` reports against it should be hidden
 *  from the public feed right now. */
export function shouldHideClip(reportCount: number): boolean {
  return reportCount >= REPORT_THRESHOLD;
}
