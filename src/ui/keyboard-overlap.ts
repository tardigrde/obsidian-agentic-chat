/**
 * How many pixels of a view's bottom the on-screen keyboard covers. On a phone the app
 * container shrinks above the keyboard but the sidebar drawer does not, so the covered
 * part is the view's bottom minus the app container's bottom (never negative).
 */
export function keyboardOverlap(viewBottom: number, appBottom: number): number {
  if (!Number.isFinite(viewBottom) || !Number.isFinite(appBottom)) return 0;
  return Math.max(0, Math.round(viewBottom - appBottom));
}
