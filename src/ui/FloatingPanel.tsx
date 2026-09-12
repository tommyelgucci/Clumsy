import { useEffect, type ReactNode } from 'react';
import { CloseIcon } from './icons';

/**
 * A closeable overlay panel anchored over the canvas — Layers/Brush/Color
 * all use this (task 2.13), matching Trace's own `Panel` (ui/controls.tsx):
 * the canvas fills the whole screen and detail panels float on top of it
 * instead of permanently sharing layout space with it. That's a real
 * structural fix, not a re-skin: task 2.12's approach (a capped, always-
 * visible, internally-scrolling panel docked beside/below the canvas)
 * still meant the canvas had to shrink to make room for it. A floating
 * panel means the canvas is always its full natural size; the panel just
 * sits over part of it while open, and closing it (or the panel simply
 * not being open) gives the canvas back completely — no shrinking, no
 * layout renegotiation.
 *
 * Deliberately does not port Trace's drag-to-reposition (`useDraggable`):
 * a fixed anchor (right edge, spanning most of the viewport height) is
 * enough of an improvement on its own, and dragging is real extra state
 * (position persistence, off-screen clamping) that isn't needed to fix
 * the actual complaint that prompted this task.
 */
export function FloatingPanel({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="cl-panel" onPointerDown={(e) => e.stopPropagation()}>
      <div className="cl-panel__head">
        <h3>{title}</h3>
        <button className="cl-railbtn cl-railbtn--ghost" onClick={onClose} aria-label={`Close ${title}`}>
          <CloseIcon size={16} />
        </button>
      </div>
      <div className="cl-panel__body">{children}</div>
    </div>
  );
}
