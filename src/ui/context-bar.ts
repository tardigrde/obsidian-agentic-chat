/**
 * Pure logic behind the glanceable context-window progress bar. The fill is
 * color-coded by how full the model's context window is, mirroring the
 * notification thresholds (75% / 90%) so the visual and the toasts agree.
 */
export type ContextLevel = "ok" | "warn" | "high";

/** Bucket a context-fill fraction (0–1) into a color level. */
export function contextLevel(fraction: number): ContextLevel {
  if (fraction >= 0.9) return "high";
  if (fraction >= 0.75) return "warn";
  return "ok";
}

/** Clamp a fraction to a 0–100 integer percentage for the bar width/readout. */
export function contextPercent(fraction: number): number {
  if (!Number.isFinite(fraction) || fraction <= 0) return 0;
  return Math.min(100, Math.round(fraction * 100));
}
