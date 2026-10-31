import { browser, expect } from "@wdio/globals";

type Rect = { x: number; y: number; width: number; height: number; right: number; bottom: number };

async function rectOf(selector: string): Promise<Rect | null> {
  return await browser.execute((sel) => {
    const element = document.querySelector<HTMLElement>(sel);
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, right: rect.right, bottom: rect.bottom };
  }, selector);
}

/** The pane must not scroll sideways. A 1px tolerance absorbs fractional layout. */
export async function expectNoHorizontalOverflow(selector = ".agentic-chat-view"): Promise<void> {
  const metrics = await browser.execute((sel) => {
    const element = document.querySelector<HTMLElement>(sel) ?? document.scrollingElement;
    if (!element) return null;
    return { scrollWidth: element.scrollWidth, clientWidth: element.clientWidth };
  }, selector);

  expect(metrics).not.toBeNull();
  expect(metrics?.scrollWidth).toBeLessThanOrEqual((metrics?.clientWidth ?? 0) + 1);
}

/** The element must be fully inside the viewport. */
export async function expectWithinViewport(selector: string): Promise<void> {
  const rect = await rectOf(selector);
  expect(rect).not.toBeNull();
  const viewport = await browser.execute(() => ({ width: window.innerWidth, height: window.innerHeight }));
  if (!rect) return;

  expect(rect.x).toBeGreaterThanOrEqual(-1);
  expect(rect.y).toBeGreaterThanOrEqual(-1);
  expect(rect.right).toBeLessThanOrEqual(viewport.width + 1);
  expect(rect.bottom).toBeLessThanOrEqual(viewport.height + 1);
}

/** The element's bottom edge must sit on the container's bottom edge. */
export async function expectPinnedToBottom(selector: string, containerSelector: string): Promise<void> {
  const [rect, container] = await Promise.all([rectOf(selector), rectOf(containerSelector)]);
  expect(rect).not.toBeNull();
  expect(container).not.toBeNull();
  if (!rect || !container) return;

  expect(Math.abs(rect.bottom - container.bottom)).toBeLessThanOrEqual(2);
}

/** Two elements must not intersect. */
export async function expectNoOverlap(firstSelector: string, secondSelector: string): Promise<void> {
  const [first, second] = await Promise.all([rectOf(firstSelector), rectOf(secondSelector)]);
  expect(first).not.toBeNull();
  expect(second).not.toBeNull();
  if (!first || !second) return;

  const width = Math.min(first.right, second.right) - Math.max(first.x, second.x);
  const height = Math.min(first.bottom, second.bottom) - Math.max(first.y, second.y);
  expect(Math.max(0, width) * Math.max(0, height)).toBe(0);
}
