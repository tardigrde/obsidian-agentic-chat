/**
 * Minimal Obsidian API mock, substituted for the real `obsidian` package via
 * a vitest resolve alias. Only what the non-UI modules touch at runtime.
 */

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
export class Modal {}
export class FuzzySuggestModal {}
export class SuggestModal {
  setPlaceholder(): void {}
}
export class WorkspaceLeaf {}
export class MarkdownView {}
export class MarkdownRenderer {
  static async render(): Promise<void> {}
}
export function setIcon(): void {}

/** Stub network access: the web tools inject their own fetcher in tests. */
export function requestUrl(): Promise<{
  status: number;
  text: string;
  json: unknown;
  headers: Record<string, string>;
}> {
  return Promise.reject(new Error("requestUrl is not available in tests"));
}

/** Tiny YAML frontmatter parser: enough for `key: value` and `key: "value"` lines. */
export function parseYaml(input: string): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  for (const line of input.split(/\r?\n/)) {
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line.trim());
    if (!match) continue;
    let value: string = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    data[match[1]] = value;
  }
  return data;
}
