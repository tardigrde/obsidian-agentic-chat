import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { argValue, applyEnvFile } from "./live-env.mjs";

/*
 * Design audit runner: sends captured e2e screenshots (logs/design-audit/*)
 * to an OpenRouter vision model (Gemini Flash Lite by default) and asks for a
 * detailed UX/visual critique benchmarked against beautifului.dev's design
 * bar. Prints a markdown summary, saves raw JSON + summary under
 * logs/eval-runs/design-audit-<ts>/.
 *
 * Uses env: AGENTIC_CHAT_API_KEY, AGENTIC_CHAT_BASE_URL (default openrouter),
 * AGENTIC_CHAT_AUDIT_MODEL (default google/gemini-3.5-flash-lite).
 * --env-file=.env, --audit-dir=/path, --follow-up (adds one follow-up pass),
 * --max-requests=N (default 3, hard cap 30).
 */

const LOAD_ENV_FILE = argValue(process.argv, "--env-file") ?? ".env";
if (existsSync(path.resolve(LOAD_ENV_FILE))) applyEnvFile(path.resolve(LOAD_ENV_FILE), process.env);

const API_KEY = process.env.AGENTIC_CHAT_API_KEY?.trim();
const BASE_URL = (process.env.AGENTIC_CHAT_BASE_URL?.trim() || "https://openrouter.ai/api/v1").replace(/\/+$/, "");
const MODEL = process.env.AGENTIC_CHAT_AUDIT_MODEL?.trim() || "google/gemini-3.5-flash-lite";
const AUDIT_DIR = path.resolve(argValue(process.argv, "--audit-dir") ?? path.join("logs", "design-audit"));
const DO_FOLLOW_UP = process.argv.includes("--follow-up");
const DO_REVAMP = process.argv.includes("--revamp");
const DO_GROUNDED = process.argv.includes("--grounded");
const GROUNDED_REFERENCE = path.resolve(
  argValue(process.argv, "--bui-reference") ?? path.join("logs", "design-audit", "reference", "beautifului.md"),
);
const REVAMP_MODEL = process.env.AGENTIC_CHAT_REVAMP_MODEL?.trim() || "google/gemini-3.7-flash";
// Cap the number of OpenAI-compatible chat requests, defaulting to 3, never
// exceeding 30. A malformed/0 value falls back to 3.
const parsedMaxRequests = Number(argValue(process.argv, "--max-requests") ?? "3");
const MAX_REQUESTS = Math.min(
  Number.isFinite(parsedMaxRequests) && parsedMaxRequests >= 1 ? Math.floor(parsedMaxRequests) : 3,
  30,
);
// Cap the number of images sent per request (vision models price per image).
const parsedMaxImages = Number(process.env.AGENTIC_CHAT_AUDIT_MAX_IMAGES ?? "12");
const MAX_IMAGES_PER_REQUEST = Number.isFinite(parsedMaxImages) && parsedMaxImages >= 1 ? Math.floor(parsedMaxImages) : 12;

if (!API_KEY) {
  console.error("AGENTIC_CHAT_API_KEY is required (put it in .env or pass --env-file=…)");
  process.exit(2);
}

const SYSTEM_PROMPT = `You are a senior product designer and design lead reviewing a real product, judging it on two layers at once: (A) human-centered UX design — clarity, trust, orientability, cognitive load, and flow for the person using it — and (B) concrete visual craft — spacing rhythm, typographic hierarchy, color/status consistency, alignment, motion — down to exact px/CSS specifics. Both layers matter; the best review is multi-layered: name the human hurt and then give the exact fix.

Your design bar: beautifului.dev — a shadcn-style component gallery for AI-native interfaces (loading states, thinking traces, streaming answers, tool chips, task rows, chat/prompt bars). Calm, spacious surfaces; generous whitespace; one restrained accent; quiet secondary text; status communicated in one coherent visual language; components that feel like one system, not a stack of widgets.

The app under review: "obsidian-agentic-chat" (github.com/tardigrde/obsidian-agentic-chat), an AI agent chat panel that lives in the right sidebar of Obsidian, the note-taking app (a calm, native, muted desktop environment). It streams agent turns with: a thinking loader (3x3 pixel-grid wavefront + label + elapsed timer), a reasoning pill ("Thinking" / "Thought" with pulsing dot and timer), collapsible tool-call step cards (spinner while running, green check when done), clickable source-file chips, markdown answers, and action buttons (retry / implement / stop). Reference screenshots cover the whole journey: empty state, user message, live reasoning, tool steps (running/done/error), streamed answer, source chips, error state, and the full transcript.

Evaluate on BOTH layers, in this order of importance:

Layer A — human-centered UX:
1. Mental model — at every moment can the user tell whether the agent is thinking, reasoning, running tools, answering, stuck, or done? Is any state ambiguous or quietly alarming?
2. Trust & transparency — do tool actions feel legible and accountable? Are errors handled humanely? Do statuses over-promise ("Thinking" for 40s with nothing happening) or under-inform?
3. Orientability — returning to a transcript mid-session or days later, can the user reconstruct what happened and why? Do reasoning, steps, and source chips tell a readable story?
4. Efficiency & flow — are send, edit, retry, stop, open-source, and follow-up where the user expects them? Is anything buried, duplicated, or in the way at the moment of peak cognitive load (streaming text + reasoning + steps at once)?
5. Calm & restraint — is the surface quiet or noisy? Does it compete with the note being written, or invite the user to sit with the agent?

Layer B — visual craft:
6. Status/indicator language — do the loader grid, pulsing dot, spinner, and checkmark speak one status dialect or three different ones? Is green used consistently and meaningfully? Do the same-sized/similar-colored dots mean the same thing everywhere?
7. Spacing rhythm & alignment — 4/8px rhythm, padding inside pills/chips/cards, gaps between dots, labels, times, and chevrons, baseline alignment of icons — flag every place the rhythm breaks (name the missing px).
8. Typography hierarchy — sizes/weights of user text vs assistant text vs reasoning labels vs step names vs chips vs buttons; is the scale legible and consistent?
9. Native-Obsidian fit — does it look crafted into Obsidian or pasted in from a web SaaS? Density, border color/width, radii, shadow/glow restraint, matching the app's sidebar chrome.
10. Interaction polish — hover/focus/active states on chips, chevrons, buttons; motion subtlety; empty-state composition; scrollbar; forced-colors/keyboard operability.

For every finding, give the exact fix at the right layer — a UX behavior change when the issue is human-level, an exact CSS/px/property change when it is craft-level. Be direct, specific, and concrete; a thoughtful senior designer reviewing this would not hedge or flatter.

Return STRICT JSON with this shape:
{
  "overview": "5-8 sentence overall diagnosis: what this product reads like, the single biggest human-experience problem, and the single biggest opportunity",
  "strengths": ["what genuinely serves the user and should be kept"],
  "experience_map": "2-3 sentences walking through the user's moment-by-moment experience and where it breaks or delights",
  "per_image": [
    {
      "image": "the exact filename from the screenshots",
      "diagnosis": "2-3 sentences on this screen from the user's point of view",
      "findings": [
        { "severity": "critical|major|minor|nit", "area": "trust|clarity|orientation|efficiency|calm|status-language|spacing|type|native-fit|motion|a11y",
          "layer": "human-ux|craft",
          "issue": "what is wrong", "why": "how it hurts the person using it", "fix": "concrete fix — UX change or exact CSS (px/property)" }
      ]
    }
  ],
  "global_issues": ["issues that span multiple screenshots, sharply stated"],
  "design_direction": ["3-5 directional recommendations a design lead would give — simplifying the status system, rebalancing emphasis, reducing cognitive load, deepening the transcript's story"],
  "quick_wins": [{ "fix": "one-line change", "effort": "S|M|L" }],
  "priorities": [
    { "rank": 1, "issue": "summary", "fix": "concrete change", "effort": "S|M|L", "impact": "high|med|low" }
  ]
}
Do not invent elements that are not visibly in the screenshots. Use the real filenames in per_image. Be comprehensive — this is a full multi-layered design review, long-form is welcome.`;

const USER_PROMPT = `Here are screenshots of the obsidian-agentic-chat plugin, captured live during a real agent conversation.

Filename conventions: *-full.png is the full Obsidian window, *-view.png is just the chat pane, *-crop.png is a tight close-up of one component.

Give me the full multi-layered design review now as strict JSON following the system schema: human-centered UX first, concrete visual craft and pixel-level specifics second — be as detailed and exact as the evidence allows.`;

interface AuditFinding {
  severity: string;
  area: string;
  layer?: string;
  issue: string;
  why: string;
  fix: string;
}
interface PerImage {
  image: string;
  findings: AuditFinding[];
}
interface AuditResult {
  overview?: string;
  strengths?: string[];
  per_image?: PerImage[];
  global_issues?: string[];
  quick_wins?: { fix: string; effort: string }[];
  priorities?: { rank: number; issue: string; fix: string; effort: string; impact: string }[];
}

function listImages(): string[] {
  if (!existsSync(AUDIT_DIR)) {
    console.error(`audit dir not found: ${AUDIT_DIR}`);
    process.exit(2);
  }
  const dirs = readdirSync(AUDIT_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(AUDIT_DIR, entry.name))
    .sort();
  const dir = dirs.findLast((candidate) => readdirSync(candidate).some((file) => file.endsWith(".png")));
  if (!dir) {
    console.error(`no dated capture dirs under ${AUDIT_DIR} — run the design-audit e2e spec first`);
    process.exit(2);
  }
  const files = readdirSync(dir)
    .filter((file) => file.endsWith(".png") && !file.endsWith(".small.png"))
    .map((file) => ({ dir, file: path.join(dir, file) }));
  if (files.length === 0) {
    console.error(`no pngs in ${dir}`);
    process.exit(2);
  }
  return files;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function downscale(source: string): string {
  const out = path.join(tmpdir(), `agentic-audit-${process.pid}-${path.basename(source)}.png`);
  try {
    execFileSync("magick", [source, "-resize", "1150x>", "-strip", "-quality", "88", out]);
  } catch {
    try {
      execFileSync("convert", [source, "-resize", "1150x>", "-strip", "-quality", "88", out]);
    } catch (error) {
      throw new Error(
        "ImageMagick (`magick`/`convert`) is required to downscale audit screenshots before sending. " +
          `Install it or stub the resize step. Original error: ${errorMessage(error)}`,
        { cause: error },
      );
    }
  }
  return out;
}

/** Keep downscaled payloads cached in memory so repeat passes re-encode zero files. */
const smallCache = new Map<string, string>();

function base64Of(source: string): string {
  const cached = smallCache.get(source);
  if (cached) return cached;
  const resized = downscale(source);
  try {
    const data = readFileSync(resized);
    const encoded = data.toString("base64");
    smallCache.set(source, encoded);
    return encoded;
  } finally {
    try {
      unlinkSync(resized);
    } catch {
      // temp cleanup is best-effort
    }
  }
}

/**
 * Pick a bounded, deduped image set per request: prefer each state's tight
 * crop, fall back to the pane view, then the full window. Keeps vision calls
 * (and per-image billing) bounded on multi-pass runs.
 */
function pickImages(images: { dir: string; file: string }[]): { dir: string; file: string }[] {
  const byState = new Map<string, { file: string; rank: number }[]>();
  for (const entry of images) {
    const base = path.basename(entry.file);
    const state = base.replace(/\.(crop|view|full)\.png$/, "");
    const rank = base.endsWith(".crop.png") ? 0 : base.endsWith(".view.png") ? 1 : 2;
    const bucket = byState.get(state) ?? [];
    bucket.push({ file: entry.file, rank });
    byState.set(state, bucket);
  }
  const chosen: { dir: string; file: string }[] = [];
  for (const bucket of byState.values()) {
    bucket.sort((a, b) => a.rank - b.rank);
    chosen.push({ dir: path.dirname(bucket[0].file), file: bucket[0].file });
  }
  chosen.sort((a, b) => a.file.localeCompare(b.file));
  return chosen.slice(0, MAX_IMAGES_PER_REQUEST);
}

function buildImageParts(images: { dir: string; file: string }[]): { type: string; image_url: { url: string } }[] {
  return pickImages(images).map(({ file }) => ({
    type: "image_url",
    image_url: { url: `data:image/png;base64,${base64Of(file)}` },
  }));
}

async function resolveModel(override?: string): Promise<string> {
  const preferred = override?.trim() || MODEL;
  const res = await fetch(`${BASE_URL}/models`);
  if (!res.ok) return preferred;
  const body = (await res.json()) as { data?: { id: string }[] };
  const ids = (body.data ?? []).map((entry) => entry.id);
  const lite = ids.find((id) => /gemini.*flash.*lite/i.test(id));
  const gemini = ids.find((id) => /^google\/gemini/i.test(id));
  if (ids.includes(preferred)) return preferred;
  return override ? preferred : lite ?? gemini ?? preferred;
}

async function runCompletion(model: string, messages: unknown[]): Promise<string> {
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify({
      model,
      messages,
      response_format: { type: "json_object" },
      temperature: 0.3,
      max_tokens: 10_000,
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`audit request failed: ${res.status} ${text.slice(0, 500)}`);
  }
  const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const content = body.choices?.[0]?.message?.content ?? "";
  if (!content) throw new Error("empty audit response");
  return content;
}

function parseJson<T>(raw: string): T {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error(`non-JSON model output:\n${raw.slice(0, 300)}`);
  return JSON.parse(raw.slice(start, end + 1)) as T;
}

function mdSummary(key: string, result: AuditResult): string {
  const lines: string[] = [`# Agentic-chat design audit`, `\n**Model:** ${key}`, `**Date:** ${new Date().toISOString()}`, ``];
  if (result.overview) lines.push(`## Overview\n\n${result.overview}\n`);
  if (result.strengths?.length) lines.push(`## Strengths\n${result.strengths.map((s) => `- ${s}`).join("\n")}\n`);
  if (result.global_issues?.length) lines.push(`## Global issues\n${result.global_issues.map((s) => `- ${s}`).join("\n")}\n`);
  for (const per of result.per_image ?? []) {
    lines.push(`## ${per.image}\n`);
    for (const finding of per.findings ?? []) {
      lines.push(
        `- **[${finding.severity}] ${finding.area}** — ${finding.issue}\n  - why: ${finding.why}\n  - fix: ${finding.fix}`,
      );
    }
    lines.push("");
  }
  if (result.quick_wins?.length) {
    lines.push(`## Quick wins\n${result.quick_wins.map((w) => `- [${w.effort}] ${w.fix}`).join("\n")}\n`);
  }
  if (result.priorities?.length) {
    lines.push(`## Priorities\n`);
    for (const p of result.priorities) {
      lines.push(`1. **[#${p.rank}] (${p.impact}, ${p.effort})** ${p.issue}\n   - fix: ${p.fix}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

async function main(): Promise<void> {
  const images = listImages() as { dir: string; file: string }[];
  console.log(`audit: ${images.length} images from ${images[0].dir}`);
  const outRoot = path.join("logs", "eval-runs");
  mkdirSync(outRoot, { recursive: true });
  const dir = path.join(outRoot, `design-audit-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  mkdirSync(dir, { recursive: true });

  const model = await resolveModel();
  console.log(`model: ${model}`);

  const baseMessages = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: [{ type: "text", text: USER_PROMPT }, ...buildImageParts(images)] },
  ];

  let requests = 0;
  const raw = await runCompletion(model, baseMessages);
  requests += 1;

  const result = parseJson<AuditResult>(raw);
  writeFileSync(path.join(dir, "audit.json"), JSON.stringify({ model, images: images.map((i) => path.basename(i.file)), result }, null, 2), "utf8");
  writeFileSync(path.join(dir, "audit.md"), mdSummary(model, result), "utf8");
  console.log(`\n${mdSummary(model, result)}\n`);
  console.log(`saved: ${dir}`);

  if (DO_FOLLOW_UP && requests < MAX_REQUESTS) {
    const followUp = `A human needs a focused second pass. Given the audit below, produce a multi-layered "design patch" plan: for each critical/major issue give the smallest set of changes — UX behavior changes where the problem is human-level, exact CSS edits (selector + property values) where it is craft-level — ordered by impact. Be as long and specific as needed; do not shorten for brevity. Return JSON: { "patch_steps": [ { "selector": "…", "change": "…", "layer": "human-ux|craft", "issue": "…" } ] }.

Audit: ${raw}`;
    const followRaw = await runCompletion(model, [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: [{ type: "text", text: followUp }, ...buildImageParts(images)] },
    ]);
    requests += 1;
    const patch = parseJson<{ patch_steps?: { selector: string; change: string; issue: string }[] }>(followRaw);
    writeFileSync(path.join(dir, "patch.json"), JSON.stringify(patch, null, 2), "utf8");
    console.log(`\n# Design patch\n${(patch.patch_steps ?? []).map((step) => `- **${step.selector}** — ${step.change} (_${step.issue}_)`).join("\n")}\n`);
  }

  if (DO_REVAMP && requests < MAX_REQUESTS) {
    const revampModel = (await resolveModel(REVAMP_MODEL)) as string;
    const revampPrompt = `You are stepping in as the design lead after the first audit round. The screenshot set and the first-pass audit below are attached. Your task: design the COHERENT DESIGN SYSTEM the first pass asked for — but bigger: a refined, human-centered revamp of the whole chat pane, not a patch list. It must feel calm, native to Obsidian, and pleasurable to use — beautifului.dev (github.com/beautifului/shadcn-table) is the aesthetic benchmark. Design on two levels:

Level 1 — DESIGN SYSTEM (the core deliverable):
- A single unified STATUS GRAMMAR: one primitive set (e.g. six size-tokens of dot/ indicator) reused across thinking, reasoning, and tool execution — describe each primitive with CSS (size, radius, color, animation) and where each is used.
- A spacing and density system: a 4/8px rhythm with explicit values for card padding, chip padding, gaps between dot/label/chevron/time, section spacing.
- A type scale: exact sizes/weights/colors for user text, assistant text, reasoning labels, step names, chips, timers, errors, empty state.
- Color discipline: which green (thinking/trust) vs accent vs muted — exact hex/css-var values.
- Component anatomy: reasoning pill, step cards (running/done/error), source chips, composer card, empty state, error banner — each restated in the system.

Level 2 — HUMAN-CENTERED UX REVAMP:
- Reduce cognitive load at peak moments: what should be invisible by default, collapsible, or deferred?
- Make the transcript read as a story: clear arc from intent → process → evidence → answer.
- Give calm, non-alarming error recovery: restate the error, the cause in one line, and the single best next action as a button.
- Make the composer the quiet center of gravity: inviting, not overwhelming.

Balance: sustained improvement, not a redesign for its own sake — keep what already works (inline tool transparency, live timers, compact control bar). Be concrete enough to implement directly in CSS.

Return STRICT JSON:
{
  "design_principles": ["5-7 governing principles for the revamp"],
  "status_system": { "primitives": [{ "name": "…", "css": "…", "used_for": "…" }] },
  "spacing_system": { "scale": "explicit px rhythm", "tokens": [{ "token": "…", "value": "…" }] },
  "type_system": [{ "role": "…", "css": "…" }],
  "color_system": [{ "role": "…", "value": "…" }],
  "component_anatomy": [{ "component": "…", "css": "…", "notes": "…" }],
  "ux_revamp": [{ "change": "…", "human_benefit": "…", "effort": "S|M|L" }],
  "implementation_order": ["ordered steps", "with selectors/classes"],
  "risks": ["what to watch out for"],
  "summary": "2-3 sentence pitch of the revamp"
}

First-pass audit to build on: ${raw}`;
    const revampRaw = await runCompletion(revampModel, [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: [{ type: "text", text: revampPrompt }, ...buildImageParts(images)] },
    ]);
    requests += 1;
    const revamp = parseJson<Record<string, unknown>>(revampRaw);
    writeFileSync(path.join(dir, "revamp.json"), JSON.stringify({ model: revampModel, revamp }, null, 2), "utf8");
    console.log(`\n=== REVAMP PROPOSAL (${revampModel}) ===\n${JSON.stringify(revamp, null, 2)}\n`);
    console.log(`saved: ${path.join(dir, "revamp.json")}`);
  }
  if (DO_GROUNDED && requests < MAX_REQUESTS) {
    const groundedModel = (await resolveModel(REVAMP_MODEL)) as string;
    const reference = existsSync(GROUNDED_REFERENCE) ? readFileSync(GROUNDED_REFERENCE, "utf8") : "";
    if (!reference) throw new Error(`beautifului reference not found: ${GROUNDED_REFERENCE}`);
    const groundedPrompt = `You are the design lead implementing an actual redesign, working from REAL reference material from beautifului.dev (the library our design is ported from) — its exact tokens, keyframes, radius/shadow values and component vocabulary — attached below under <BEAUTIFULUI_REFERENCE>. The Obsidian plugin screenshots + first-pass audit + revamp proposal are also attached.

Your job: produce the CONCRETE PORT SPEC that takes obsidian-agentic-chat from where it is now to that Beautiful UI design language, mapped onto Obsidian's native theme CSS variables. Requirements:

1. Use ONLY the real obsidian-agentic-chat CSS classes listed in the reference (never invent class names). For any new token the app needs, define it on the app's existing root/container.
2. Reuse Beautiful UI's exact keyframes and values (pixel-on, shimmer-text, pop-in, spin, the 4px-cell/1.5px-gap grid, tabular-nums timers, the green-tint pill + pop-in check for Completed, the ring-spinner-with-count for running, the quiet unboxed text + caret for streaming, the expanded source panel bg, radius chips/control/card, hairline shadows).
3. Map each app surface to the equivalent Beautiful UI primitive: thinking loader -> Loading State; reasoning pill -> Thinking; tool steps -> Task Rows; source chips -> Streaming Text source chip row; error -> tinted error pill + quiet panel; composer -> Prompt Bar.
4. Resolve the known tensions: thinking green dot vs tool green check vs loader grid -> one status grammar; 6px vs 8px gaps; harsh error red; spacing rhythm.
5. State the exact CSS changes (selector, property, value) as an ordered diff that could be applied to styles.css, including keyframe additions, token mappings, and which Obsidian vars back each Beautiful UI token.
6. Keep the port Native to Obsidian: soft hairline borders, no glow, restrained animation, calm.

Return STRICT JSON:
{
  "status_grammar": { "primitives": [{ "name": "…", "selector": "real-class", "css": "…", "used_for": "…" }] },
  "token_mapping": [{ "beautiful_ui_token": "…", "obsidian_variable_or_value": "…" }],
  "keyframes_to_add": [{ "name": "…", "css": "exact @keyframes body" }],
  "sections": [
    { "component": "reasoning-pill|loader|steps|sources|error|composer|empty-state|user-bubble",
      "currently": "…", "to_become": "…", "diff_steps": [{ "selector": "…", "change": "…" }] }
  ],
  "spacing_system": { "values": [{ "token": "…", "value": "…" }] },
  "ux_refinements": [{ "change": "…", "human_benefit": "…", "effort": "S|M|L" }],
  "implementation_order": ["…"],
  "risks": ["…"],
  "summary": "2-3 sentence pitch"
}

<BEAUTIFULUI_REFERENCE>
${reference}
</BEAUTIFULUI_REFERENCE>

First-pass audit: ${raw}`;
    const groundedRaw = await runCompletion(groundedModel, [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: [{ type: "text", text: groundedPrompt }, ...buildImageParts(images)] },
    ]);
    requests += 1;
    const grounded = parseJson<Record<string, unknown>>(groundedRaw);
    writeFileSync(path.join(dir, "revamp-grounded.json"), JSON.stringify({ model: groundedModel, reference: GROUNDED_REFERENCE, grounded }, null, 2), "utf8");
    console.log(`\n=== GROUNDED REVAMP SPEC (${groundedModel}) ===`);
    console.log(`summary: ${JSON.stringify((grounded.summary as string | undefined) ?? "")}`);
    console.log(`status grammar: ${JSON.stringify((grounded.status_grammar as unknown) ?? "")}`);
    console.log(`sections: ${JSON.stringify(((grounded.sections as { component: string }[] | undefined) ?? []).map((s) => s.component))}`);
    console.log(`\nsaved: ${path.join(dir, "revamp-grounded.json")}`);
  }
  console.log(`requests used: ${requests}/${MAX_REQUESTS}`);
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});