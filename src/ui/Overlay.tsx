import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';

/**
 * Renders full-screen UI (dialogs, the feed, the export progress) directly
 * under `.cl-app`. The buttons that open them live inside the floating
 * rails, which use `backdrop-filter` — and a `backdrop-filter` ancestor
 * becomes the containing block for `position: fixed` descendants, so an
 * overlay rendered in place would be sized to the rail instead of the
 * screen. `.cl-app` itself is fixed with no filter/transform, so fixed
 * children of it really are viewport-relative (and it is also where the
 * `--surface`/`--text` tokens are defined, which a portal to `body` would
 * lose).
 */
export function Overlay({ children }: { children: ReactNode }) {
  const host = document.querySelector('.cl-app');
  return host ? createPortal(children, host) : null;
}
