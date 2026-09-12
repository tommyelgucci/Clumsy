/**
 * Small hand-authored stroke icons for the drawing UI — no icon library
 * dependency, no emoji (CLAUDE.md's UI copy conventions and the general
 * "no emoji unless asked" rule apply to icons too). Generic geometric
 * shapes for universal concepts (eye, lock, trash), each self-contained
 * so a button's accessible name always comes from its own text/aria-label,
 * never the icon — every icon is `aria-hidden`.
 */
type IconProps = { size?: number };

const common = { fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };

export function UndoIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" {...common}>
      <path d="M9 14 4 9l5-5" />
      <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
    </svg>
  );
}

export function RedoIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" {...common}>
      <path d="m15 14 5-5-5-5" />
      <path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13" />
    </svg>
  );
}

export function TrashIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" {...common}>
      <path d="M4 7h16" />
      <path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
      <path d="M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13" />
      <path d="M10 11v6" />
      <path d="M14 11v6" />
    </svg>
  );
}

export function EyeIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" {...common}>
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

export function EyeOffIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" {...common}>
      <path d="M3 3l18 18" />
      <path d="M10.6 5.2A10.7 10.7 0 0 1 12 5c6.5 0 10 7 10 7a15.7 15.7 0 0 1-3.2 4.1" />
      <path d="M6.5 6.7C4 8.3 2 12 2 12s3.5 7 10 7a9.7 9.7 0 0 0 4.4-1" />
      <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
    </svg>
  );
}

export function LockIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" {...common}>
      <rect x="4" y="10" width="16" height="10" rx="2" />
      <path d="M7 10V7a5 5 0 0 1 10 0v3" />
    </svg>
  );
}

export function UnlockIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" {...common}>
      <rect x="4" y="10" width="16" height="10" rx="2" />
      <path d="M7 10V7a5 5 0 0 1 9-3" />
    </svg>
  );
}

export function PlusIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" {...common}>
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

export function ChevronUpIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" {...common}>
      <path d="m6 15 6-6 6 6" />
    </svg>
  );
}

export function ChevronDownIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" {...common}>
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

export function BucketIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" {...common}>
      <path d="M3 11 12 3l8 8-9 9-8-8Z" />
      <path d="m10 5 8 8" />
      <path d="M18 15c1.5 1.5 2 2.5 2 3.5a2 2 0 1 1-4 0c0-1 .5-2 2-3.5Z" />
    </svg>
  );
}

export function PencilIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" {...common}>
      <path d="M4 20l1-4L16 5l3 3L8 19l-4 1Z" />
      <path d="m14 6.5 3 3" />
    </svg>
  );
}

export function LayersIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" {...common}>
      <path d="m12 3 9 5-9 5-9-5 9-5Z" />
      <path d="m3 13 9 5 9-5" />
    </svg>
  );
}

export function CloseIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" {...common}>
      <path d="M6 6l12 12M18 6 6 18" />
    </svg>
  );
}

export function StepBackIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" {...common}>
      <path d="M6 5v14" />
      <path d="M18 6 8 12l10 6Z" />
    </svg>
  );
}

export function StepForwardIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" {...common}>
      <path d="M18 5v14" />
      <path d="M6 6l10 6-10 6Z" />
    </svg>
  );
}

export function DuplicateFrameIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" {...common}>
      <rect x="4" y="7" width="12" height="13" rx="2" />
      <path d="M8 7V6a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-1" />
    </svg>
  );
}

export function NewProjectIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" {...common}>
      <path d="M7 3h7l4 4v14a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z" />
      <path d="M14 3v4h4" />
      <path d="M12 12v5M9.5 14.5h5" />
    </svg>
  );
}

export function LassoIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" {...common} strokeDasharray="2.5 2.5">
      <path d="M12 3c-5 0-9 3-9 7 0 3 2.5 5 5.5 5.5L7 20l3-2.5c.6.1 1.3.2 2 .2 5 0 9-3 9-7s-4-7-9-7Z" />
    </svg>
  );
}

export function TransformIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" {...common}>
      <path d="M12 2v4M12 18v4M2 12h4M18 12h4" />
      <rect x="7" y="7" width="10" height="10" rx="1.5" />
    </svg>
  );
}

export function KeyframeIcon({ size = 16, filled = false }: IconProps & { filled?: boolean }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" {...common} fill={filled ? 'currentColor' : 'none'}>
      <path d="M12 3 21 12 12 21 3 12Z" />
    </svg>
  );
}

export function OnionIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" {...common}>
      <circle cx="12" cy="12" r="8" opacity="0.4" />
      <circle cx="10" cy="12" r="8" opacity="0.7" />
      <circle cx="12" cy="12" r="8" />
    </svg>
  );
}
