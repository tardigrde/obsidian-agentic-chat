/**
 * Minimal Obsidian API mock, substituted for the real `obsidian` package via
 * a vitest resolve alias. Only what the non-UI modules touch at runtime.
 */
import { createRequire } from "node:module";

const requireFromMock = createRequire(import.meta.url);
// Obsidian ships only type declarations. The tool-use eval runner maps the bare
// `obsidian` specifier to this mock so the shared frontmatter splitter works in
// Node too. js-yaml matches the real parser closely enough for grading.
const yaml = requireFromMock("js-yaml") as { load(input: string): unknown };

export class TAbstractFile {
  path = "";
  name = "";
  parent: TFolder | null = null;
}

export class TFile extends TAbstractFile {
  extension = "md";
  basename = "";
}

export class TFolder extends TAbstractFile {
  children: TAbstractFile[] = [];

  isRoot(): boolean {
    return this.path === "/";
  }
}

export function normalizePath(path: string): string {
  return path
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/")
    .replace(/^\//, "")
    .replace(/\/$/, "");
}

export class App {
  vault: unknown;
  workspace: unknown;
}

export class Notice {
  constructor(public message: string) {}
}

export class Component {}
export class ItemView extends Component {}
export class Plugin extends Component {}
export class PluginSettingTab {}
export class Setting {}
export class Modal {
  constructor(public app?: unknown) {}
}
export class FuzzySuggestModal {
  constructor(public app?: unknown) {}
  setPlaceholder(): void {
    // No-op stub: the real Obsidian method configures the search input placeholder.
  }
  setInstructions(): void {
    // No-op stub: the real Obsidian method renders the instruction hints.
  }
}
export class SuggestModal {
  constructor(public app?: unknown) {}
  setPlaceholder(): void {
    // No-op stub: the real Obsidian method configures the search input placeholder.
  }
  setInstructions(): void {
    // No-op stub: the real Obsidian method renders the instruction hints.
  }
}
export class WorkspaceLeaf {}
export class MarkdownView {}
export class MarkdownRenderer {
  static async render(): Promise<void> {
    // No-op stub: the real Obsidian method renders markdown to HTML.
  }
}
export async function loadMermaid(): Promise<{ render: () => string }> {
  return ((globalThis as { __obsidianMockMermaid?: { render: () => string } }).__obsidianMockMermaid ?? {
    render: () => "",
  });
}
export function setIcon(): void {
  // No-op stub: the real Obsidian method renders an icon into a container.
}

export const Platform = {
  isDesktopApp: true,
};

/** Stub network access: the web tools inject their own fetcher in tests. */
export function requestUrl(): Promise<{
  status: number;
  text: string;
  json: unknown;
  headers: Record<string, string>;
  arrayBuffer?: ArrayBuffer;
}> {
  return Promise.reject(new Error("requestUrl is not available in tests"));
}

/** YAML frontmatter parser backed by js-yaml, matching Obsidian's real parser. */
export function parseYaml(input: string): Record<string, unknown> {
  for (const line of input.split(/\r?\n/)) {
    // js-yaml rejects tab indentation; mirror the error path in src too.
    if (line.includes("\t")) throw new Error("found character that cannot start any token");
  }
  const parsed = yaml.load(input);
  return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
}
