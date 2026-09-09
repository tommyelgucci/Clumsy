/**
 * Tool selection (active brush + color) for the drawing UI. Split out
 * the same way `palettes.ts` already is, for the same reason stated
 * there: Trace's `state/store.ts` mixes this with panels/quick-shape/rig
 * state Clumsyloop doesn't have yet, so there's nothing to port besides
 * these two fields. Not persisted — unlike palettes (a person's
 * standing preference) or a saved project, "what brush was selected"
 * is session-only, same as it would reset on a fresh open of any
 * drawing app.
 */
import { create } from 'zustand';
import { DEFAULT_BRUSHES } from '../core/brush';
import type { RGB } from '../core/types';

interface ToolState {
  activeBrushId: string;
  activeColor: RGB;
  setActiveBrush: (id: string) => void;
  setActiveColor: (color: RGB) => void;
}

export const useTool = create<ToolState>((set) => ({
  activeBrushId: DEFAULT_BRUSHES[0].id,
  activeColor: { r: 0.1, g: 0.1, b: 0.1 },
  setActiveBrush: (id) => set({ activeBrushId: id }),
  setActiveColor: (color) => set({ activeColor: color }),
}));
