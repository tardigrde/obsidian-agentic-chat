/**
 * Below this window width the desktop layout cannot hold both sidebars: the
 * default footprint is ribbon 44 + left sidebar 300 + chat 300 = 644 px, so a
 * 300 px chat in the right sidebar ends past the window edge (#393 T16). The
 * margin covers a slightly wider sidebar.
 */
export const NARROW_WINDOW_PX = 700;

/**
 * Whether "Open chat" should collapse the left sidebar so the chat fits.
 * Obsidian Mobile uses drawers, so it never needs this. Obsidian's own
 * sidebar toggle brings the left sidebar back.
 */
export function shouldCollapseLeftSidebar(windowWidth: number, isMobile: boolean, leftCollapsed: boolean): boolean {
  return !isMobile && !leftCollapsed && windowWidth < NARROW_WINDOW_PX;
}
