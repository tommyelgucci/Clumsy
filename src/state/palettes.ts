/**
 * Color palette system, ported directly from Trace's `state/store.ts`
 * (tommyelgucci/Draw) — see CLAUDE.md, "What Clumsyloop is": palettes have
 * nothing to do with the camera or monetization, so this ports as-is, no
 * redesign. Split out into its own store rather than folded into a
 * broader UI store, since Clumsyloop's tool/panel/selection state doesn't
 * exist yet (that's task 2.3, the capture UI) and this shouldn't wait on it.
 *
 * `PaletteGroup`: the fixed, curated palettes — same data as Trace's, same
 * owner, so porting the actual color values isn't a licensing question,
 * just moving the same judgment call between two of their own projects.
 * `UserPalette`: palettes the person using the app creates themselves,
 * persisted in `localStorage` — a preference of the person, not of any
 * one project.
 */
import { create } from 'zustand';
import { hexToRgb, hsvToRgb } from '../core/math';
import type { RGB } from '../core/types';

export interface PaletteGroup {
  name: string;
  colors: RGB[];
}

/** User-created palette: unlike `PaletteGroup` it has an `id` (the name is
 * editable and doesn't work as a key) and lives in `localStorage`, not in
 * the document — it's a preference of the person, not of the drawing. */
export interface UserPalette {
  id: string;
  name: string;
  colors: RGB[];
}

const USER_PALETTES_KEY = 'clumsyloop:palettes';

function loadUserPalettes(): UserPalette[] {
  try {
    const raw = localStorage.getItem(USER_PALETTES_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveUserPalettes(list: UserPalette[]) {
  try {
    localStorage.setItem(USER_PALETTES_KEY, JSON.stringify(list));
  } catch {
    // Quota full or storage blocked (private browsing): the session
    // carries on the same, it just won't survive a reload.
  }
}

/** Evenly spaced hue wheel, same brightness and saturation throughout. */
function hueWheel(count: number, s: number, v: number, offset = 0): RGB[] {
  return Array.from({ length: count }, (_, i) => hsvToRgb((i / count + offset) % 1, s, v));
}

/** Gray ramp from black to white, with more steps in the middle than at the ends. */
const NEUTRALS: RGB[] = [
  { r: 0.05, g: 0.05, b: 0.06 },
  { r: 0.22, g: 0.22, b: 0.24 },
  { r: 0.42, g: 0.42, b: 0.44 },
  { r: 0.62, g: 0.62, b: 0.64 },
  { r: 0.82, g: 0.82, b: 0.84 },
  { r: 1, g: 1, b: 1 },
];

/**
 * Earth and skin tones: not derived from the hue wheel because they need
 * their own combination of saturation and brightness, not a uniform shift.
 */
const EARTH_SKIN: RGB[] = [
  { r: 0.8, g: 0.6, b: 0.28 }, // ochre
  { r: 0.7, g: 0.4, b: 0.22 }, // burnt sienna
  { r: 0.78, g: 0.35, b: 0.28 }, // terracotta
  { r: 0.38, g: 0.25, b: 0.18 }, // burnt umber
  { r: 0.9, g: 0.78, b: 0.58 }, // sand
  { r: 0.96, g: 0.8, b: 0.68 }, // peach
  { r: 0.92, g: 0.78, b: 0.68 }, // rosy beige
  { r: 0.28, g: 0.16, b: 0.11 }, // chocolate
];

/** Converts a list of hex strings to `RGB[]` — more readable than typing
 *  fractions by hand for palettes curated from a reference image (no
 *  pixels are copied, only the judgment of what color each patch
 *  represents). */
const hexList = (hexes: string[]): RGB[] => hexes.map(hexToRgb);

// The ten palettes below come from reference images (several
// AI-generated, with the hex text sometimes wrong relative to the actual
// color of the patch — a known image-generation quirk, not a reliable
// source of truth). The hex values here are visual judgment about each
// patch's color, not a transcription of any text the image carried.
const FOREST: RGB[] = hexList([
  '#2f4f2f', '#3a6b35', '#4f9d5c', '#0f3d2e', '#6b8f47',
  '#9caf6b', '#c9d94a', '#7a5230', '#5c4030', '#8a8a7a', '#c9a86a', '#d98a8a',
]);
const ANCIENT_ART: RGB[] = hexList([
  '#3d7ea6', '#2f7a7a', '#f0c419', '#d4691e', '#a13d1f', '#4a2e1a', '#c9a876', '#8fa8c9',
]);
const RENAISSANCE_ART: RGB[] = hexList([
  '#7a8a6a', '#a15c4a', '#6a7a8a', '#4a3826', '#c97a3a', '#e8dcc0', '#3a5a6a', '#8a6a8a',
]);
const IMPRESSIONIST_ART: RGB[] = hexList([
  '#d9a521', '#4a7a3a', '#1f4a2f', '#7a8ac9', '#e88a5a', '#f0c8a0', '#8aa87a', '#2f5a8a', '#6a4a8a',
]);
const WINTER: RGB[] = hexList(['#8a1a5c', '#3a1a5c', '#1a2a6c', '#0a5c3a', '#2ab5c9', '#e91e8a']);
const SUMMER: RGB[] = hexList(['#c97a94', '#b0a0c9', '#a0bcd9', '#8fae94', '#a67c94', '#d9c9a0']);
const AUTUMN: RGB[] = hexList(['#a83a1f', '#6a5c1f', '#c98a1f', '#4a3020', '#c9602f']);
const SPRING: RGB[] = hexList(['#e85c6a', '#f0c020', '#4aa83a', '#4a9ad9', '#e88aa8']);
const OCEAN: RGB[] = hexList([
  '#7ab0d9', '#2a6a9a', '#1a3a5c', '#2fae9a', '#0a6a5a', '#f0a888', '#e8654a', '#8a7a6a', '#4a4038',
]);
const TWILIGHT: RGB[] = hexList([
  '#1a1a3a', '#3a2a6a', '#6a4a9a', '#a05a8a', '#c97a5a', '#e8a83a', '#f0d980', '#1a2a1a', '#0a0a0a',
]);
const GOLDEN_HOUR: RGB[] = hexList([
  '#ffd700', '#ffa500', '#ff6a2a', '#d9391f', '#8a1a1a', '#a83a5c', '#6a2a7a', '#4a1a5c',
]);
const MOUNTAIN: RGB[] = hexList([
  '#2f3320', '#5c6a5a', '#515c43', '#9d989a', '#445454', '#8a684c', '#5c768f', '#382a40', '#cc7105', '#b56323',
]);

// These two, on the other hand, came from outside the AI-generated batch
// (a real paint swatch and a pastel-combination reference sheet) — added
// to the existing "Pastels" palette instead of opening a new one.
const PASTEL_EXTRA: RGB[] = hexList([
  '#c7c0b4', // muted beige
  '#54615f', // pewter
  '#c2bc8a', // dried grass
  '#f2ebd9', // cream
  '#cc8148', // terracotta
  '#9cc2a0', '#b8e0bc', '#d4edb0', '#363a54', '#4a8a78', '#f0d0d8',
  '#f4837e', '#f5c79a', '#1a6e7e', '#c9bc9e', '#c0dce0',
  '#90b89a', '#e0a85c', '#9a7268', '#93a8b8',
]);

const DEFAULT_PALETTE_GROUPS: PaletteGroup[] = [
  { name: 'Neutrals', colors: NEUTRALS },
  { name: 'Spectrum', colors: hueWheel(12, 0.8, 0.92) },
  // Offset from the spectrum so it doesn't repeat the same lightened
  // hues; extended with a selection from two reference sheets.
  { name: 'Pastels', colors: [...hueWheel(6, 0.35, 0.98, 0.04), ...PASTEL_EXTRA] },
  { name: 'Earth & skin', colors: EARTH_SKIN },
  { name: 'Forest', colors: FOREST },
  { name: 'Ancient art', colors: ANCIENT_ART },
  { name: 'Renaissance art', colors: RENAISSANCE_ART },
  { name: 'Impressionist art', colors: IMPRESSIONIST_ART },
  { name: 'Winter', colors: WINTER },
  { name: 'Summer', colors: SUMMER },
  { name: 'Autumn', colors: AUTUMN },
  { name: 'Spring', colors: SPRING },
  { name: 'Ocean', colors: OCEAN },
  { name: 'Twilight', colors: TWILIGHT },
  { name: 'Golden hour', colors: GOLDEN_HOUR },
  { name: 'Mountain', colors: MOUNTAIN },
];

interface PalettesState {
  /** Fixed, curated palettes — not user-editable. */
  paletteGroups: PaletteGroup[];
  userPalettes: UserPalette[];
  createUserPalette: (name: string) => void;
  renameUserPalette: (id: string, name: string) => void;
  deleteUserPalette: (id: string) => void;
  addColorToUserPalette: (id: string, color: RGB) => void;
  removeColorFromUserPalette: (id: string, index: number) => void;
}

export const usePalettes = create<PalettesState>((set) => ({
  paletteGroups: DEFAULT_PALETTE_GROUPS,
  userPalettes: loadUserPalettes(),

  createUserPalette: (name) =>
    set((s) => {
      const userPalettes = [...s.userPalettes, { id: crypto.randomUUID(), name, colors: [] }];
      saveUserPalettes(userPalettes);
      return { userPalettes };
    }),
  renameUserPalette: (id, name) =>
    set((s) => {
      const userPalettes = s.userPalettes.map((p) => (p.id === id ? { ...p, name } : p));
      saveUserPalettes(userPalettes);
      return { userPalettes };
    }),
  deleteUserPalette: (id) =>
    set((s) => {
      const userPalettes = s.userPalettes.filter((p) => p.id !== id);
      saveUserPalettes(userPalettes);
      return { userPalettes };
    }),
  addColorToUserPalette: (id, color) =>
    set((s) => {
      const userPalettes = s.userPalettes.map((p) =>
        p.id === id ? { ...p, colors: [...p.colors, color] } : p,
      );
      saveUserPalettes(userPalettes);
      return { userPalettes };
    }),
  removeColorFromUserPalette: (id, index) =>
    set((s) => {
      const userPalettes = s.userPalettes.map((p) =>
        p.id === id ? { ...p, colors: p.colors.filter((_, i) => i !== index) } : p,
      );
      saveUserPalettes(userPalettes);
      return { userPalettes };
    }),
}));
