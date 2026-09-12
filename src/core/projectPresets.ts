/**
 * Canvas format presets offered at project creation (task 2.15) — the
 * owner's confirmed decision ("Preset al crear el proyecto") over a
 * single fixed default or free-form custom sizing, matching how
 * Procreate/ToonSquid/Clip Studio Paint all handle canvas size. Sizes
 * here stay at the same modest resolution `DrawingCanvas.tsx` already
 * used for its single default (360x640) rather than jumping to a
 * production-quality size like 1080x1920: that's a separate, bigger
 * decision (GPU memory, render cost) nobody has made yet — `newDocument`'s
 * own default of 1080x1920 is flagged elsewhere (see CLAUDE.md's
 * 2026-09-11 correction) as a leftover from the wrong TikTok-only
 * assumption and still unreplaced. This module only decides the ASPECT
 * RATIO choice a user makes at creation time, not the final production
 * resolution.
 */
export interface FormatPreset {
  id: string;
  label: string;
  width: number;
  height: number;
}

export const FORMAT_PRESETS: FormatPreset[] = [
  { id: 'vertical', label: 'Vertical 9:16', width: 360, height: 640 },
  { id: 'horizontal', label: 'Horizontal 16:9', width: 640, height: 360 },
  { id: 'square', label: 'Square 1:1', width: 480, height: 480 },
];
