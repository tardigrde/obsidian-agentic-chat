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

type ComposerHit = {
  hit: boolean;
  input: Rect | null;
  root: Rect | null;
  rightSplit: Rect | null;
  window: { width: number; height: number };
  hitClass: string;
};

/**
 * Whether a real click at the composer's center would land on the composer, plus
 * layout widths. It reads the current window's document: switch back to the main
 * window before calling it after a settings popout.
 */
export async function composerHitTest(): Promise<ComposerHit> {
  return await browser.execute(() => {
    const box = (element: Element | null) => {
      if (!element) return null;
      const r = element.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom };
    };
    const input = document.querySelector<HTMLElement>(".agentic-chat-input");
    // WebDriver scrolls an element into view before it clicks; do the same.
    input?.scrollIntoView({ block: "nearest", inline: "nearest" });
    const rect = input?.getBoundingClientRect();
    let hit = false;
    let hitClass = "";
    if (input && rect && rect.width > 0 && rect.height > 0) {
      const target = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      hit = target === input || (target !== null && input.contains(target));
      hitClass = target instanceof HTMLElement ? target.className.toString().slice(0, 80) : "";
    }
    return {
      hit,
      input: box(input),
      root: box(document.querySelector(".workspace-split.mod-root")),
      rightSplit: box(document.querySelector(".workspace-split.mod-right-split")),
      window: { width: window.innerWidth, height: window.innerHeight },
      hitClass,
    };
  });
}

/**
 * Wait until a click on the chat composer lands on it. On CI the composer can
 * stay unreachable for longer than WebdriverIO's 5 s click retry right after the
 * chat opens in the right sidebar (2026-11-12, approval-deterministic). A
 * timeout reports the layout widths, so the next failure explains itself.
 */
export async function waitForComposerReady({ timeoutMs = 15_000 } = {}): Promise<void> {
  let last: ComposerHit | undefined;
  await browser
    .waitUntil(
      async () => {
        last = await composerHitTest();
        return last.hit;
      },
      { timeout: timeoutMs, interval: 250 },
    )
    .catch((error: unknown) => {
      throw new Error(`chat composer never became reachable within ${timeoutMs} ms: ${JSON.stringify(last)}`, {
        cause: error,
      });
    });
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
