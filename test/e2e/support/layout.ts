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
    const input = document.querySelector<HTMLElement>('[data-ac="composer-input"]');
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
export async function expectNoHorizontalOverflow(selector = '[data-ac="view"]'): Promise<void> {
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

/**
 * Each element must sit inside the window horizontally. `expectNoHorizontalOverflow`
 * compares a pane with itself, so it passes when the whole pane is wider than the
 * window; this compares against `window.innerWidth` (#393 T16).
 */
export async function expectWithinWindow(selectors: string[]): Promise<void> {
  const report = await browser.execute((list) => {
    const width = window.innerWidth;
    return list.map((selector) => {
      const element = document.querySelector<HTMLElement>(selector);
      if (!element) return { selector, missing: true, x: 0, right: 0, width };
      const rect = element.getBoundingClientRect();
      return { selector, missing: false, x: Math.round(rect.x), right: Math.round(rect.right), width };
    });
  }, selectors);
  const bad = report.filter((entry) => entry.missing || entry.x < -1 || entry.right > entry.width + 1);
  if (bad.length > 0) {
    throw new Error(
      `outside the ${report[0]?.width}px window: ` +
        bad.map((entry) => (entry.missing ? `${entry.selector} missing` : `${entry.selector} x=${entry.x} right=${entry.right}`)).join("; ") +
        ` (all: ${report.map((entry) => `${entry.selector} ${entry.x}..${entry.right}`).join(", ")})`,
    );
  }
}

/** `expectWithinWindow`, retried until it holds: a sidebar collapse animates. */
export async function waitWithinWindow(selectors: string[], timeout = 5_000): Promise<void> {
  let last: unknown;
  try {
    await browser.waitUntil(
      async () => {
        try {
          await expectWithinWindow(selectors);
          return true;
        } catch (error) {
          last = error;
          return false;
        }
      },
      { timeout, interval: 100 },
    );
  } catch {
    throw last instanceof Error ? last : new Error(String(last));
  }
}

/**
 * The visible children matching `childSelector` inside each `containerSelector`
 * must not overlap one another: a row's box may not cut into the next row
 * (U4 #2: a thought row showed the top of its second line under the next
 * row's border). A 1px tolerance absorbs borders and fractional layout.
 */
export async function expectNoOverlapWithin(containerSelector: string, childSelector: string): Promise<void> {
  const overlaps = await browser.execute(
    (container, child) => {
      const bad: string[] = [];
      for (const root of Array.from(document.querySelectorAll(container))) {
        const rects = Array.from(root.querySelectorAll<HTMLElement>(child))
          .filter((el) => el.getClientRects().length > 0 && getComputedStyle(el).display !== "none")
          .map((el) => ({ el, rect: el.getBoundingClientRect() }));
        for (let i = 0; i < rects.length; i += 1) {
          for (let j = i + 1; j < rects.length; j += 1) {
            const a = rects[i].rect;
            const b = rects[j].rect;
            if (rects[i].el.contains(rects[j].el) || rects[j].el.contains(rects[i].el)) continue;
            const width = Math.min(a.right, b.right) - Math.max(a.left, b.left);
            const height = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
            if (width > 1 && height > 1) bad.push(`${child}[${i}] ${Math.round(a.top)}..${Math.round(a.bottom)} overlaps [${j}] ${Math.round(b.top)}..${Math.round(b.bottom)}`);
          }
        }
      }
      return bad;
    },
    containerSelector,
    childSelector,
  );
  if (overlaps.length > 0) throw new Error(`overlapping rows: ${overlaps.join("; ")}`);
}

/**
 * Each visible element matching `selector` shows all of its own content: no
 * clipped text (scroll size within the client box). A one-line row that hides
 * a second line under `overflow: hidden` fails here, where `height > 0` passes.
 */
export async function expectTextFits(selector: string): Promise<void> {
  const clipped = await browser.execute((sel) => {
    return Array.from(document.querySelectorAll<HTMLElement>(sel))
      .filter((el) => el.getClientRects().length > 0 && getComputedStyle(el).display !== "none")
      .map((el, index) => ({ index, text: (el.textContent ?? "").slice(0, 40), scroll: el.scrollHeight, client: el.clientHeight }))
      .filter((entry) => entry.scroll > entry.client + 1);
  }, selector);
  if (clipped.length > 0) {
    throw new Error(`clipped content in ${selector}: ${clipped.map((entry) => `#${entry.index} "${entry.text}" ${entry.scroll}>${entry.client}`).join("; ")}`);
  }
}
