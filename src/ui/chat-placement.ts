/**
 * Below this window width the desktop layout cannot hold both sidebars: with
 * the left sidebar open, a 300 px chat in the right sidebar starts past the
 * window edge (#393 T16).
 */
export const NARROW_WINDOW_PX = 600;

/**
 * Whether "Open chat" should collapse the left sidebar so the chat fits.
 * Obsidian Mobile uses drawers, so it never needs this. Obsidian's own
 * sidebar toggle brings the left sidebar back.
 */
export function shouldCollapseLeftSidebar(windowWidth: number, isMobile: boolean, leftCollapsed: boolean): boolean {
  return !isMobile && !leftCollapsed && windowWidth < NARROW_WINDOW_PX;
}
