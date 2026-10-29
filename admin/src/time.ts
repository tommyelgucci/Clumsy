const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** "5h 12m" for a span; minutes only under an hour; "0m" at zero. */
export function formatSpan(ms: number): string {
  const total = Math.max(0, Math.floor(ms / MINUTE));
  const h = Math.floor(total / 60);
  const m = total % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

export type Urgency = 'ok' | 'soon' | 'overdue';

/** How the 24-hour deadline stands. `soon` is the last four hours, when a
 *  moderator should be working this one first. */
export function dueStatus(dueAtMs: number, now: number): { urgency: Urgency; label: string } {
  const left = dueAtMs - now;
  if (left <= 0) return { urgency: 'overdue', label: `OVERDUE by ${formatSpan(-left)}` };
  return { urgency: left <= 4 * HOUR ? 'soon' : 'ok', label: `due in ${formatSpan(left)}` };
}

/** Reasons as a compact tally, most common first: "spam ×2, harassment". */
export function tallyReasons(reasons: string[]): string {
  const counts = new Map<string, number>();
  for (const r of reasons) counts.set(r, (counts.get(r) ?? 0) + 1);
  return [...counts]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([r, n]) => (n > 1 ? `${r} ×${n}` : r))
    .join(', ');
}
