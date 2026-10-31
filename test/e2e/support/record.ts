import { $, browser } from "@wdio/globals";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

type TimelineEntry = { t: number; label: string };

const outDir = process.env.AGENTIC_CHAT_PROBE_OUT?.trim();
const startedAt = Number(process.env.AGENTIC_CHAT_PROBE_STARTED_AT ?? Date.now());

export function probeMode(): boolean {
  return process.env.AGENTIC_CHAT_PROBE === "1";
}

/** Record a decisive moment. The probe runner extracts a keyframe at this time. */
export async function mark(label: string): Promise<void> {
  if (!outDir) return;
  await mkdir(outDir, { recursive: true });
  const file = path.join(outDir, "timeline.json");
  const entry: TimelineEntry = { t: Number(((Date.now() - startedAt) / 1000).toFixed(3)), label };

  let timeline: TimelineEntry[] = [];
  try {
    timeline = JSON.parse(await readFile(file, "utf8")) as TimelineEntry[];
  } catch {
    // First mark in this run.
  }

  timeline.push(entry);
  await writeFile(file, `${JSON.stringify(timeline, null, 2)}\n`);
}

/** Merge a metrics object into the probe's metrics.json. */
export async function writeMetrics(metrics: Record<string, unknown>): Promise<void> {
  if (!outDir) return;
  await mkdir(outDir, { recursive: true });
  const file = path.join(outDir, "metrics.json");
  let existing: Record<string, unknown> = {};
  try {
    existing = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
  } catch {
    // First metrics write in this run.
  }
  await writeFile(file, `${JSON.stringify({ ...existing, ...metrics }, null, 2)}\n`);
}

/**
 * Click an element and draw a short ripple at its center.
 * Synthesized WebDriver clicks do not move the X pointer, so the recording would
 * otherwise show a state change with no visible cause.
 */
export async function clickWithRipple(selector: string): Promise<void> {
  const center = await browser.execute((sel) => {
    const element = document.querySelector<HTMLElement>(sel);
    if (!element) return null;
    element.scrollIntoView({ block: "center", inline: "center" });
    const rect = element.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  }, selector);

  if (!center) throw new Error(`clickWithRipple: ${selector} not found`);

  if (probeMode()) {
    await browser.execute(({ x, y }) => {
      const dot = document.createElement("div");
      dot.style.cssText = [
        "position:fixed",
        `left:${x - 12}px`,
        `top:${y - 12}px`,
        "width:24px",
        "height:24px",
        "border-radius:50%",
        "border:2px solid #ff3b30",
        "background:rgba(255,59,48,0.18)",
        "pointer-events:none",
        "z-index:2147483647",
        "transition:transform 350ms ease-out,opacity 350ms ease-out",
      ].join(";");
      document.body.appendChild(dot);
      requestAnimationFrame(() => {
        dot.style.transform = "scale(2.4)";
        dot.style.opacity = "0";
      });
      setTimeout(() => dot.remove(), 450);
    }, center);
    await new Promise((resolve) => setTimeout(resolve, 180));
  }

  await $(selector).click();
}
