/**
 * Undo stack with a memory budget. Ported from Trace's core/history.ts.
 *
 * Simplified from Trace: `Command` there carries an optional `op` field
 * (from `historyOps.ts`) so some steps can be reconstructed from disk on
 * load. Local persistence is task 2.5, not yet built — `op` comes back
 * once there's an `io.ts` to reconstruct from.
 */
export interface Command {
  label: string;
  undo(): void;
  redo(): void;
  /** Approximate bytes retained, to budget the stack. */
  cost?: number;
  /** The id of the layer this command's undo/redo closures act on, if
   *  any — lets `discardForLayer` find and drop every command tied to a
   *  layer that no longer exists (see that method's own comment for why
   *  this matters). Optional: history isn't exclusively layer-scoped
   *  content in general (Trace's own port of this module has no such
   *  concept), only Clumsyloop's `Engine` happens to tag every command
   *  it creates with one, since every one of its commands acts on
   *  exactly one layer's cel or transform. */
  layerId?: string;
}

const MAX_STEPS = 120;
/** History memory budget. A phone doesn't forgive much more than this. */
const MAX_BYTES = 320 * 1024 * 1024;

export class History {
  private past: Command[] = [];
  private future: Command[] = [];
  private bytes = 0;
  private listeners = new Set<() => void>();

  push(cmd: Command) {
    this.past.push(cmd);
    this.bytes += cmd.cost ?? 0;
    // A new action invalidates the future.
    for (const c of this.future) this.bytes -= c.cost ?? 0;
    this.future.length = 0;
    this.trim();
    this.emit();
  }

  /** Runs and records in a single step. */
  run(cmd: Command) {
    cmd.redo();
    this.push(cmd);
  }

  private trim() {
    while (this.past.length > MAX_STEPS || (this.bytes > MAX_BYTES && this.past.length > 1)) {
      const dropped = this.past.shift();
      if (!dropped) break;
      this.bytes -= dropped.cost ?? 0;
    }
  }

  undo(): boolean {
    const cmd = this.past.pop();
    if (!cmd) return false;
    cmd.undo();
    this.future.push(cmd);
    this.emit();
    return true;
  }

  redo(): boolean {
    const cmd = this.future.pop();
    if (!cmd) return false;
    cmd.redo();
    this.past.push(cmd);
    this.emit();
    return true;
  }

  clear() {
    this.past.length = 0;
    this.future.length = 0;
    this.bytes = 0;
    this.emit();
  }

  /**
   * Drops every command tagged with `layerId` from both stacks — for
   * when the layer itself is gone (a Codex review caught the bug this
   * fixes): `Engine.removeLayer` releases a deleted layer's GPU surfaces
   * immediately, since layer removal itself isn't undoable, but every
   * PRIOR stroke/fill/clear/selection command on that layer was still
   * sitting in this same stack, its closures still holding a reference
   * to the now-destroyed surface. WebGL recycles a deleted texture's
   * object name for the next `createTexture` call, so undoing far enough
   * to reach one of those stale commands wouldn't just fail loudly — it
   * could silently write the deleted layer's old pixels onto whatever
   * unrelated layer's surface happens to have been assigned that same
   * recycled GL name since. Discarding those commands outright (rather
   * than leaving them to fail some other way) is the same choice
   * `removeLayer` already made about the removal itself: once a layer is
   * gone, its edit history isn't meaningfully undoable either.
   */
  discardForLayer(layerId: string) {
    const before = this.past.length + this.future.length;
    const keep = (cmd: Command) => cmd.layerId !== layerId;
    this.past = this.past.filter((cmd) => {
      const keeping = keep(cmd);
      if (!keeping) this.bytes -= cmd.cost ?? 0;
      return keeping;
    });
    this.future = this.future.filter((cmd) => {
      const keeping = keep(cmd);
      if (!keeping) this.bytes -= cmd.cost ?? 0;
      return keeping;
    });
    if (this.past.length + this.future.length !== before) this.emit();
  }

  get pastCommands(): readonly Command[] {
    return this.past;
  }

  get canUndo() {
    return this.past.length > 0;
  }

  get canRedo() {
    return this.future.length > 0;
  }

  get undoLabel() {
    return this.past[this.past.length - 1]?.label ?? '';
  }

  get redoLabel() {
    return this.future[this.future.length - 1]?.label ?? '';
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit() {
    for (const fn of this.listeners) fn();
  }
}
