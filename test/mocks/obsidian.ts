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
export class FuzzySuggestModal {}
export class WorkspaceLeaf {}
export class MarkdownRenderer {
  static async render(): Promise<void> {}
}
export function setIcon(): void {}
