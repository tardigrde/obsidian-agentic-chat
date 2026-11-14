/**
 * Deterministic synthetic vault for the tool-use evals.
 *
 * Pure Node: no Obsidian import, no filesystem, no network. The runner writes
 * the files. The same `(size, seed)` pair gives byte-identical output, so a
 * diff between two eval runs is the model's work and not the seed's.
 *
 * The shape mimics a bilingual second brain: numbered PARA folders, daily
 * notes, templates, frontmatter, links, embeds, block refs, old copies, and
 * deliberate contradictions that a retrieval or edit task has to resolve.
 */

export type VaultSize = "S" | "M";

export interface GeneratedVault {
  size: VaultSize;
  seed: number;
  files: Record<string, string>;
}

const NOTE_COUNTS: Record<VaultSize, number> = { S: 50, M: 500 };
const SIZE_SALT: Record<VaultSize, number> = { S: 0x5a17, M: 0x51a7 };
const DAY_MS = 86_400_000;
const YEAR = 2024;
const DAYS_IN_YEAR = 366;

const FOLDERS = {
  inbox: "000 Inbox",
  staging: "100 Staging",
  resources: "200 Resources",
  areas: "300 Areas",
  projects: "400 Projects",
  journal: "500 Journal",
  templates: "800 Templates",
  archive: "900 Archive",
} as const;

/** Projects and resources get more notes than inbox and staging. */
const LIVE_FOLDERS: readonly string[] = [
  FOLDERS.projects,
  FOLDERS.areas,
  FOLDERS.resources,
  FOLDERS.staging,
  FOLDERS.inbox,
  FOLDERS.projects,
  FOLDERS.resources,
  FOLDERS.areas,
  FOLDERS.projects,
  FOLDERS.resources,
  FOLDERS.areas,
  FOLDERS.staging,
  FOLDERS.resources,
];

const ATTACHMENTS: Readonly<Record<string, string>> = {
  "000 Inbox/capture-2024-02-11.txt":
    "Voice capture, 2024-02-11.\n\nBudget question came up again. Check the sheet in 200 Resources/Data before the next sync.\n",
  "200 Resources/Data/budget-2024.csv":
    "category,planned,actual\nrent,1200,1180\ntravel,900,1040\nsoftware,420,399\ntraining,600,250\n",
  "200 Resources/Data/koltsegvetes-2024.csv":
    "kategória,tervezett,tényleges\nlakbér,1200,1180\nutazás,900,1040\nszoftver,420,399\nképzés,600,250\n",
};

interface Variable {
  en: string;
  hu: string;
}

interface Kind extends Variable {
  /** ASCII tag, so tags stay easy to type in a query. */
  tag: string;
}

interface Topic {
  title: Variable;
  alias: Variable;
  tags: readonly string[];
  huTags: readonly string[];
  /** Two answers to the same question. Older notes keep the first one. */
  fact: { en: readonly [string, string]; hu: readonly [string, string] };
}

const TOPICS: readonly Topic[] = [
  {
    title: { en: "Atlas Launch", hu: "Atlasz indítás" },
    alias: { en: "Atlas", hu: "Atlasz" },
    tags: ["project", "atlas"],
    huTags: ["projekt", "atlasz"],
    fact: { en: ["Deadline: March 3", "Deadline: March 10"], hu: ["Határidő: március 3.", "Határidő: március 10."] },
  },
  {
    title: { en: "Borealis Migration", hu: "Borealisz átállás" },
    alias: { en: "Borealis", hu: "Borealisz" },
    tags: ["project", "borealis"],
    huTags: ["projekt", "borealisz"],
    fact: { en: ["Server region: eu-west", "Server region: us-east"], hu: ["Szerver régió: eu-west", "Szerver régió: us-east"] },
  },
  {
    title: { en: "Quarterly Budget", hu: "Negyedéves költségvetés" },
    alias: { en: "Budget", hu: "Költségvetés" },
    tags: ["finance", "budget"],
    huTags: ["penzugy", "koltsegvetes"],
    fact: { en: ["Budget: 12,000 EUR", "Budget: 14,500 EUR"], hu: ["Költségvetés: 12 000 EUR", "Költségvetés: 14 500 EUR"] },
  },
  {
    title: { en: "Hiring Plan", hu: "Felvételi terv" },
    alias: { en: "Hiring", hu: "Felvétel" },
    tags: ["team", "hiring"],
    huTags: ["csapat", "felvetel"],
    fact: { en: ["Open roles: 2", "Open roles: 3"], hu: ["Nyitott pozíciók: 2", "Nyitott pozíciók: 3"] },
  },
  {
    title: { en: "Kitchen Renovation", hu: "Konyhafelújítás" },
    alias: { en: "Kitchen", hu: "Konyha" },
    tags: ["home", "renovation"],
    huTags: ["otthon", "felujitas"],
    fact: { en: ["Contractor: Keleti Konyha", "Contractor: Dunai Konyha"], hu: ["Kivitelező: Keleti Konyha", "Kivitelező: Dunai Konyha"] },
  },
  {
    title: { en: "Reading List", hu: "Olvasmánylista" },
    alias: { en: "Reading", hu: "Olvasmányok" },
    tags: ["reading", "notes"],
    huTags: ["olvasas", "jegyzetek"],
    fact: { en: ["Books this year: 18", "Books this year: 24"], hu: ["Könyvek idén: 18", "Könyvek idén: 24"] },
  },
  {
    title: { en: "Garden Plan", hu: "Kertiterv" },
    alias: { en: "Garden", hu: "Kert" },
    tags: ["home", "garden"],
    huTags: ["otthon", "kert"],
    fact: { en: ["Planting week: April 6", "Planting week: April 20"], hu: ["Ültetési hét: április 6.", "Ültetési hét: április 20."] },
  },
  {
    title: { en: "Lisbon Trip", hu: "Lisszaboni utazás" },
    alias: { en: "Lisbon", hu: "Lisszabon" },
    tags: ["travel", "lisbon"],
    huTags: ["utazas", "lisszabon"],
    fact: { en: ["Flight date: May 4", "Flight date: May 11"], hu: ["Repülőjárat: május 4.", "Repülőjárat: május 11."] },
  },
  {
    title: { en: "Health Checkup", hu: "Egészségügyi vizsgálat" },
    alias: { en: "Checkup", hu: "Vizsgálat" },
    tags: ["health", "appointments"],
    huTags: ["egeszseg", "idopontok"],
    fact: { en: ["Next checkup: June 2", "Next checkup: June 16"], hu: ["Következő vizsgálat: június 2.", "Következő vizsgálat: június 16."] },
  },
  {
    title: { en: "Tax Notes", hu: "Adóügyi jegyzetek" },
    alias: { en: "Taxes", hu: "Adó" },
    tags: ["finance", "tax"],
    huTags: ["penzugy", "ado"],
    fact: { en: ["Filing deadline: May 20", "Filing deadline: June 10"], hu: ["Beadási határidő: május 20.", "Beadási határidő: június 10."] },
  },
  {
    title: { en: "Meeting Cadence", hu: "Megbeszélés ritmus" },
    alias: { en: "Cadence", hu: "Ritmus" },
    tags: ["team", "meetings"],
    huTags: ["csapat", "megbeszeles"],
    fact: { en: ["Weekly sync: Tuesday 9:00", "Weekly sync: Wednesday 10:00"], hu: ["Heti sync: kedd 9:00", "Heti sync: szerda 10:00"] },
  },
  {
    title: { en: "Onboarding Guide", hu: "Bevezetési útmutató" },
    alias: { en: "Onboarding", hu: "Bevezetés" },
    tags: ["team", "guide"],
    huTags: ["csapat", "utmutato"],
    fact: { en: ["Onboarding length: 2 weeks", "Onboarding length: 3 weeks"], hu: ["Bevezetés hossza: 2 hét", "Bevezetés hossza: 3 hét"] },
  },
  {
    title: { en: "Vendor Contracts", hu: "Beszállítói szerződések" },
    alias: { en: "Vendors", hu: "Beszállítók" },
    tags: ["legal", "vendors"],
    huTags: ["jog", "beszallitok"],
    fact: { en: ["Renewal: August 1", "Renewal: September 1"], hu: ["Megújítás: augusztus 1.", "Megújítás: szeptember 1."] },
  },
  {
    title: { en: "Conference Talk", hu: "Konferencia előadás" },
    alias: { en: "Talk", hu: "Előadás" },
    tags: ["writing", "talk"],
    huTags: ["iras", "eloadas"],
    fact: { en: ["Talk length: 20 minutes", "Talk length: 30 minutes"], hu: ["Előadás hossza: 20 perc", "Előadás hossza: 30 perc"] },
  },
  {
    title: { en: "Home Server", hu: "Otthoni szerver" },
    alias: { en: "Server", hu: "Szerver" },
    tags: ["home", "infra"],
    huTags: ["otthon", "uzemeltetes"],
    fact: { en: ["Disk size: 4 TB", "Disk size: 8 TB"], hu: ["Lemezméret: 4 TB", "Lemezméret: 8 TB"] },
  },
  {
    title: { en: "Writing Habit", hu: "Írási szokás" },
    alias: { en: "Writing", hu: "Írás" },
    tags: ["writing", "habit"],
    huTags: ["iras", "szokas"],
    fact: { en: ["Daily words: 500", "Daily words: 750"], hu: ["Napi szószám: 500", "Napi szószám: 750"] },
  },
  {
    title: { en: "Language Learning", hu: "Nyelvtanulás" },
    alias: { en: "Languages", hu: "Nyelv" },
    tags: ["learning", "language"],
    huTags: ["tanulas", "nyelv"],
    fact: { en: ["Study streak: 120 days", "Study streak: 145 days"], hu: ["Tanulási sorozat: 120 nap", "Tanulási sorozat: 145 nap"] },
  },
  {
    title: { en: "Client Proposal", hu: "Ügyfél ajánlat" },
    alias: { en: "Proposal", hu: "Ajánlat" },
    tags: ["work", "proposal"],
    huTags: ["munka", "ajanlat"],
    fact: { en: ["Proposal total: 8,400 EUR", "Proposal total: 9,600 EUR"], hu: ["Ajánlat összege: 8 400 EUR", "Ajánlat összege: 9 600 EUR"] },
  },
];

const KINDS: readonly Kind[] = [
  { en: "Overview", hu: "Áttekintés", tag: "overview" },
  { en: "Plan", hu: "Terv", tag: "plan" },
  { en: "Research", hu: "Kutatás", tag: "research" },
  { en: "Decisions", hu: "Döntések", tag: "decisions" },
  { en: "Timeline", hu: "Ütemterv", tag: "timeline" },
  { en: "Budget", hu: "Költségvetés", tag: "budget" },
  { en: "Risks", hu: "Kockázatok", tag: "risks" },
  { en: "Meeting Notes", hu: "Megbeszélés jegyzetek", tag: "meetings" },
  { en: "Retrospective", hu: "Utólagos értékelés", tag: "retro" },
  { en: "Open Questions", hu: "Nyitott kérdések", tag: "questions" },
  { en: "Sources", hu: "Források", tag: "sources" },
  { en: "Checklist", hu: "Ellenőrzőlista", tag: "checklist" },
  { en: "Draft", hu: "Vázlat", tag: "draft" },
  { en: "Handover", hu: "Átadás", tag: "handover" },
  { en: "Notes", hu: "Jegyzetek", tag: "notes" },
  { en: "Summary", hu: "Összefoglaló", tag: "summary" },
];

const TEMPLATES: readonly { name: Variable; body: readonly string[] }[] = [
  {
    name: { en: "Daily note", hu: "Napi jegyzet" },
    body: ["## {{date}}", "", "- Three priorities", "  - [ ] ", "  - [ ] ", "- Journal", "  - "],
  },
  {
    name: { en: "Meeting note", hu: "Megbeszélés jegyzet" },
    body: ["## Attendees", "", "- ", "", "## Agenda", "", "1. ", "", "## Decisions", "", "- ", "", "## Actions", "", "- [ ] "],
  },
  {
    name: { en: "Project note", hu: "Projekt jegyzet" },
    body: ["## Goal", "", "", "## Scope", "", "- ", "", "## Milestones", "", "| Date | Milestone |", "|---|---|", "|  |  |"],
  },
  {
    name: { en: "Book note", hu: "Könyvjegyzet" },
    body: ["## Metadata", "", "- Author: ", "- Finished: ", "", "## Key ideas", "", "- ", "", "## Quotes", "", "> "],
  },
  {
    name: { en: "Client proposal", hu: "Ügyfél ajánlat" },
    body: ["## Scope", "", "- ", "", "## Price", "", "| Item | Amount |", "|---|---|", "|  |  |"],
  },
  {
    name: { en: "Decision record", hu: "Döntési jegyzőkönyv" },
    body: ["## Context", "", "", "## Decision", "", "", "## Consequences", "", "- "],
  },
  {
    name: { en: "Weekly review", hu: "Heti összefoglaló" },
    body: ["## Wins", "", "- ", "", "## Blockers", "", "- ", "", "## Next week", "", "- [ ] "],
  },
  {
    name: { en: "Travel plan", hu: "Utazási terv" },
    body: ["## Dates", "", "- Departure: ", "- Return: ", "", "## Bookings", "", "- [ ] Flight", "- [ ] Hotel"],
  },
];

interface Labels {
  updated: string;
  summary: string;
  context: string;
  decisions: string;
  tasks: string;
  related: string;
  owner: string;
  status: string;
  detail: string;
  detailItem: string;
  longParagraph: string;
  archivedCopy: string;
  supersededBy: string;
  liveCopy: string;
  journalEntry: string;
  priorities: string;
  weather: string;
  dailyAlias: string;
  templateSuffix: string;
  archived: string;
  from: string;
  decision: string;
  task: string;
  done: string;
  templateHeading: string;
}

const EN: Labels = {
  updated: "Updated",
  summary: "Summary",
  context: "Context",
  decisions: "Decisions",
  tasks: "Tasks",
  related: "Related",
  owner: "Owner",
  status: "Status",
  detail: "Detail",
  detailItem: "Follow-up item",
  longParagraph:
    "This section grew over several sessions. It keeps the raw notes, the reasoning, and the open loops in one place so the next review does not start from zero.",
  archivedCopy: "Archived copy. Keep for history; do not edit.",
  supersededBy: "Superseded by",
  liveCopy: "the live copy",
  journalEntry: "Journal entry for the day",
  priorities: "Three priorities",
  weather: "Weather",
  dailyAlias: "Daily note",
  templateSuffix: "template",
  archived: "archived",
  from: "Source",
  decision: "Decision",
  task: "Task",
  done: "Done",
  templateHeading: "Template hints",
};

const HU: Labels = {
  updated: "Frissítve",
  summary: "Összefoglaló",
  context: "Háttér",
  decisions: "Döntések",
  tasks: "Feladatok",
  related: "Kapcsolódó",
  owner: "Felelős",
  status: "Állapot",
  detail: "Részletek",
  detailItem: "Következő lépés",
  longParagraph:
    "Ez a rész több alkalom alatt gyűlt össze. Nyers jegyzetek, érvelés és nyitott kérdések egy helyen, hogy a következő átnézés ne nulláról induljon.",
  archivedCopy: "Archivált másolat. Történeti okból maradt meg, ne szerkeszd.",
  supersededBy: "Felváltotta",
  liveCopy: "az élő változat",
  journalEntry: "Napi bejegyzés",
  priorities: "Három prioritás",
  weather: "Időjárás",
  dailyAlias: "Napi jegyzet",
  templateSuffix: "sablon",
  archived: "archivált",
  from: "Forrás",
  decision: "Döntés",
  task: "Feladat",
  done: "Kész",
  templateHeading: "Sablon tippek",
};

const OWNERS = ["Ada", "Ben", "Kata", "Dávid", "Eszter", "Márton", "Nóra", "Zsolt"] as const;
const STATUS_EN = ["active", "draft", "in review", "waiting"] as const;
const STATUS_HU = ["aktív", "vázlat", "átnézés alatt", "várakozik"] as const;
const WEATHER_EN = ["sunny", "rain", "wind", "cold but clear"] as const;
const WEATHER_HU = ["napos", "esős", "szeles", "hideg, de tiszta"] as const;
const PRIORITY_EN = ["inbox zero", "budget review", "write the draft", "call the vendor", "walk before lunch"] as const;
const PRIORITY_HU = ["nulla bejövő", "költségvetés átnézés", "vázlat írása", "beszállító hívása", "séta ebéd előtt"] as const;

interface NoteSpec {
  path: string;
  basename: string;
  folder: string;
  title: string;
  topic?: Topic;
  kindName: string;
  hungarian: boolean;
  long: boolean;
  daily: boolean;
  archived: boolean;
  /** 0 keeps the older fact, 1 the newer one. */
  factIndex: 0 | 1;
  /** Live source path without `.md`, for an archive copy. */
  sourcePath?: string;
  templateBody?: readonly string[];
  hash: number;
}

interface RenderContext {
  seed: number;
  links: readonly string[];
  templates: readonly string[];
  dailies: readonly string[];
  attachments: readonly string[];
}

export function generateVault(size: VaultSize, seed: number): GeneratedVault {
  if (size !== "S" && size !== "M") {
    throw new Error(`Unknown vault size: ${String(size)}. Use "S" or "M".`);
  }
  if (!Number.isInteger(seed) || seed < 0) {
    throw new Error("The vault seed must be a non-negative integer.");
  }

  const rng = mulberry32((seed ^ SIZE_SALT[size]) >>> 0);
  const specs = buildSpecs(size, rng);
  const context: RenderContext = {
    seed,
    links: specs.filter((spec) => !spec.archived && !spec.daily && spec.templateBody === undefined).map((spec) => spec.basename),
    templates: specs.filter((spec) => spec.templateBody !== undefined).map((spec) => spec.basename),
    dailies: specs.filter((spec) => spec.daily).map((spec) => spec.basename),
    attachments: Object.keys(ATTACHMENTS).map((filePath) => filePath.slice(filePath.lastIndexOf("/") + 1)),
  };

  const files = new Map<string, string>();
  for (const spec of specs) {
    if (files.has(spec.path)) throw new Error(`Duplicate generated path: ${spec.path}`);
    files.set(spec.path, renderNote(spec, context));
  }
  for (const [filePath, content] of Object.entries(ATTACHMENTS)) {
    if (files.has(filePath)) throw new Error(`Duplicate generated path: ${filePath}`);
    files.set(filePath, content);
  }

  return { size, seed, files: Object.fromEntries(files) };
}

function buildSpecs(size: VaultSize, rng: () => number): NoteSpec[] {
  const total = NOTE_COUNTS[size];
  const dailyCount = Math.max(1, Math.round(total * 0.24));
  const templateCount = size === "S" ? 4 : TEMPLATES.length;
  const archiveCount = Math.max(1, Math.round(total * 0.12));
  const liveCount = total - dailyCount - templateCount - archiveCount;
  if (liveCount < 1) throw new Error(`Vault size ${size} is too small for the generator.`);

  // Exactly 27% of the notes are Hungarian. Archive copies inherit the language
  // of the live note they copy, so both shares are budgeted here.
  const hungarianTotal = Math.round(total * 0.27);
  const hungarianArchives = Math.round(archiveCount * 0.27);
  const hungarianSlots = Math.max(0, hungarianTotal - hungarianArchives);
  const nonArchiveCount = dailyCount + templateCount + liveCount;
  const hungarianSet = new Set<number>(shuffle(range(nonArchiveCount), rng).slice(0, hungarianSlots));
  const liveSlotStart = dailyCount + templateCount;
  // Keep at least one accented live name, so the vault always exercises links
  // and search with non-ASCII paths.
  if (![...hungarianSet].some((slot) => slot >= liveSlotStart)) {
    const donor = [...hungarianSet].find((slot) => slot < liveSlotStart);
    if (donor !== undefined) {
      hungarianSet.delete(donor);
      hungarianSet.add(liveSlotStart);
    }
  }
  const usedPaths = new Set<string>();

  const dailySpecs: NoteSpec[] = [];
  for (let index = 0; index < dailyCount; index += 1) {
    const date = dateFromDay(Math.floor((index * DAYS_IN_YEAR) / dailyCount));
    const year = date.slice(0, 4);
    const basename = date;
    dailySpecs.push({
      path: uniquePath(`${FOLDERS.journal}/${year}/${basename}.md`, usedPaths),
      basename,
      folder: `${FOLDERS.journal}/${year}`,
      title: basename,
      kindName: "Daily",
      hungarian: hungarianSet.has(index),
      long: false,
      daily: true,
      archived: false,
      factIndex: 1,
      hash: hashString(basename),
    });
  }

  const templateSpecs: NoteSpec[] = [];
  for (let index = 0; index < templateCount; index += 1) {
    const template = TEMPLATES[index];
    const hungarian = hungarianSet.has(dailyCount + index);
    const basename = hungarian ? template.name.hu : template.name.en;
    templateSpecs.push({
      path: uniquePath(`${FOLDERS.templates}/${basename}.md`, usedPaths),
      basename,
      folder: FOLDERS.templates,
      title: basename,
      kindName: "Template",
      hungarian,
      long: false,
      daily: false,
      archived: false,
      factIndex: 1,
      templateBody: template.body,
      hash: hashString(basename),
    });
  }

  const liveSpecs: NoteSpec[] = [];
  const longEvery = Math.max(1, Math.floor(liveCount / Math.max(1, Math.round(total * 0.04))));
  for (let index = 0; index < liveCount; index += 1) {
    const topic = TOPICS[index % TOPICS.length];
    const kindIndex = Math.floor(index / TOPICS.length) % KINDS.length;
    const kind = KINDS[kindIndex];
    const folder = LIVE_FOLDERS[index % LIVE_FOLDERS.length];
    const hungarian = hungarianSet.has(liveSlotStart + index);
    const basename = hungarian ? `${topic.title.hu} - ${kind.hu}` : `${topic.title.en} - ${kind.en}`;
    liveSpecs.push({
      path: uniquePath(`${folder}/${basename}.md`, usedPaths),
      basename,
      folder,
      title: basename,
      topic,
      kindName: hungarian ? kind.hu : kind.en,
      hungarian,
      long: index % longEvery === 0,
      daily: false,
      archived: false,
      factIndex: kindIndex % 2 === 0 ? 1 : 0,
      hash: hashString(basename),
    });
  }

  const archiveSources = pickArchiveSources(liveSpecs, hungarianArchives, archiveCount);
  const archiveSpecs: NoteSpec[] = [];
  for (const source of archiveSources) {
    const path = uniquePath(`${FOLDERS.archive}/${source.basename}.md`, usedPaths);
    archiveSpecs.push({
      ...source,
      path,
      folder: FOLDERS.archive,
      title: source.basename,
      long: false,
      daily: false,
      archived: true,
      factIndex: 0,
      sourcePath: `${source.folder}/${source.basename}`,
      templateBody: undefined,
      hash: source.hash,
    });
  }

  const specs = [...dailySpecs, ...templateSpecs, ...liveSpecs, ...archiveSpecs];
  if (specs.length !== total) throw new Error(`Generated ${specs.length} notes, expected ${total}.`);
  return specs;
}

function pickArchiveSources(liveSpecs: NoteSpec[], hungarianCount: number, total: number): NoteSpec[] {
  const hungarianPool = liveSpecs.filter((spec) => spec.hungarian);
  const englishPool = liveSpecs.filter((spec) => !spec.hungarian);
  const sources: NoteSpec[] = [];
  const take = (pool: NoteSpec[], count: number): void => {
    for (let index = 0; index < count && pool.length > 0; index += 1) {
      sources.push(pool[index % pool.length]);
    }
  };
  take(hungarianPool.length > 0 ? hungarianPool : englishPool, hungarianCount);
  take(englishPool.length > 0 ? englishPool : hungarianPool, total - sources.length);
  return sources;
}

function renderNote(spec: NoteSpec, context: RenderContext): string {
  const rng = mulberry32((context.seed ^ spec.hash) >>> 0);
  const labels: Labels = spec.hungarian ? HU : EN;
  const baseDay = spec.hash % DAYS_IN_YEAR;
  const created = spec.daily ? spec.basename : dateFromDay(spec.archived ? Math.max(0, baseDay - 90) : baseDay);
  const otherLanguageTitle = spec.topic ? (spec.hungarian ? spec.topic.title.en : spec.topic.title.hu) : undefined;
  const aliases = spec.archived
    ? [`${spec.title} (${labels.archived})`]
    : otherLanguageTitle
      ? [otherLanguageTitle, spec.topic?.alias[spec.hungarian ? "hu" : "en"] ?? spec.title]
      : spec.daily
        ? [`${labels.dailyAlias} ${spec.title}`]
        : [`${spec.title} ${labels.templateSuffix}`];

  const lines = [
    "---",
    `title: "${spec.title}"`,
    "tags:",
    ...tagsFor(spec).map((tag) => `  - ${tag}`),
    "aliases:",
    ...aliases.map((alias) => `  - "${alias}"`),
    `created: "${created}"`,
    ...(spec.archived ? ["status: archived"] : []),
    "---",
    "",
    `# ${spec.title}`,
    "",
    `_${labels.updated}: ${created}_`,
    "",
    `## ${labels.summary}`,
    "",
  ];

  if (spec.templateBody) {
    lines.push(`- ${labels.templateHeading}`);
    lines.push("", ...spec.templateBody, "");
    return `${lines.join("\n")}\n`;
  }

  if (spec.archived) {
    lines.push(`- ${labels.archivedCopy}`);
    if (spec.sourcePath) lines.push(`- ${labels.supersededBy} [[${spec.sourcePath}|${labels.liveCopy}]]`);
  }
  if (spec.topic) {
    const facts = spec.hungarian ? spec.topic.fact.hu : spec.topic.fact.en;
    lines.push(`- ${facts[spec.factIndex]}`);
  }
  if (spec.daily) {
    lines.push(
      `- ${labels.journalEntry}`,
      `- ${labels.priorities}: ${pick(rng, spec.hungarian ? PRIORITY_HU : PRIORITY_EN)}`,
      `- ${labels.weather}: ${pick(rng, spec.hungarian ? WEATHER_HU : WEATHER_EN)}`,
    );
  } else {
    lines.push(
      `- ${labels.owner}: ${pick(rng, OWNERS)}`,
      `- ${labels.status}: ${pick(rng, spec.hungarian ? STATUS_HU : STATUS_EN)}`,
    );
  }

  const target = pickLink(rng, context.links, spec.basename);
  const second = pickLink(rng, context.links, spec.basename);
  const embed = pickLink(rng, context.links, spec.basename);
  const journal = pick(rng, context.dailies);
  lines.push(
    "",
    `## ${labels.context}`,
    "",
    `${labels.detail} ${1 + Math.floor(rng() * 9)}. ${linkText(spec.hungarian, target)} ${linkText(spec.hungarian, second)}`,
    "",
    `![[${embed}]]`,
    "",
    `## ${labels.decisions}`,
    "",
    `- ${labels.decision} [[${journal}]] ^${blockId(spec.basename, 1)}`,
    `- ${labels.from} [[${target}#^${blockId(target, 1)}]]`,
    "",
    `## ${labels.tasks}`,
    "",
    `- [ ] ${labels.task} ${1 + Math.floor(rng() * 5)}`,
    `- [x] ${labels.done}`,
    "",
    `## ${labels.related}`,
    "",
    `- [[${target}]]`,
    `- [[${pick(rng, context.templates)}]]`,
    `- ![[${pick(rng, context.attachments)}]]`,
    "",
  );

  if (spec.long) {
    for (let section = 1; section <= 6; section += 1) {
      lines.push(`## ${labels.detail} ${section}`, "", labels.longParagraph, "");
      for (let item = 1; item <= 8; item += 1) lines.push(`- ${labels.detailItem} ${section}.${item}`);
      lines.push("");
    }
  }
  return `${lines.join("\n")}\n`;
}

function linkText(hungarian: boolean, target: string): string {
  return hungarian ? `Lásd még [[${target}]].` : `See also [[${target}]].`;
}

function tagsFor(spec: NoteSpec): string[] {
  if (spec.templateBody) return spec.hungarian ? ["template", "sablon"] : ["template"];
  if (spec.archived) {
    const tags = spec.topic ? (spec.hungarian ? spec.topic.huTags : spec.topic.tags) : [];
    return ["archive", ...tags];
  }
  if (spec.daily) return ["journal", "daily", spec.basename.slice(0, 4)];
  const tags = spec.topic ? (spec.hungarian ? spec.topic.huTags : spec.topic.tags) : [];
  const kind = KINDS.find((entry) => entry.en === spec.kindName || entry.hu === spec.kindName);
  return [...tags, kind?.tag ?? "note"];
}

function pickLink(rng: () => number, links: readonly string[], self: string): string {
  if (links.length === 0) return self;
  const candidates = links.filter((link) => link !== self);
  if (candidates.length === 0) return self;
  return pick(rng, candidates);
}

function pick<T>(rng: () => number, values: readonly T[]): T {
  return values[Math.min(values.length - 1, Math.floor(rng() * values.length))];
}

function blockId(basename: string, index: number): string {
  return `blk-${hashString(basename).toString(36)}-${index}`;
}

function dateFromDay(day: number): string {
  const date = new Date(Date.UTC(YEAR, 0, 1) + day * DAY_MS);
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const dayOfMonth = String(date.getUTCDate()).padStart(2, "0");
  return `${date.getUTCFullYear()}-${month}-${dayOfMonth}`;
}

function uniquePath(candidate: string, used: Set<string>): string {
  if (!used.has(candidate)) {
    used.add(candidate);
    return candidate;
  }
  const base = candidate.replace(/\.md$/, "");
  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const next = `${base} ${suffix}.md`;
    if (!used.has(next)) {
      used.add(next);
      return next;
    }
  }
  throw new Error(`Could not make a unique path for ${candidate}.`);
}

function range(length: number): number[] {
  return Array.from({ length }, (_, index) => index);
}

/** Deterministic Fisher-Yates; the caller supplies the seeded PRNG. */
function shuffle<T>(values: T[], rng: () => number): T[] {
  for (let index = values.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(rng() * (index + 1));
    const value = values[index];
    values[index] = values[swap];
    values[swap] = value;
  }
  return values;
}

/** mulberry32: small, fast, and stable across Node versions. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** FNV-1a over UTF-16 code units: stable block ids and note timing. */
function hashString(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}
