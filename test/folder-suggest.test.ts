import { describe, expect, it, vi } from "vitest";
import { App, TFile, TFolder } from "obsidian";
import { FolderSuggestModal } from "../src/ui/folder-suggest";

function folder(path: string, children: (TFolder | TFile)[] = []): TFolder {
  const node = new TFolder();
  node.path = path;
  node.name = path.split("/").pop() ?? path;
  node.children = children;
  return node;
}

function file(path: string): TFile {
  const node = new TFile();
  node.path = path;
  return node;
}

function appWithRoot(root: TFolder): App {
  const app = new App();
  (app as unknown as { vault: { getRoot: () => TFolder } }).vault = { getRoot: () => root };
  return app;
}

describe("FolderSuggestModal", () => {
  it("collects every folder depth-first while skipping files", () => {
    const root = folder("/", [
      folder("Projects", [file("Projects/todo.md"), folder("Projects/2024", [])]),
      file("root-note.md"),
      folder("Archive", []),
    ]);
    const modal = new FolderSuggestModal(appWithRoot(root), () => {});

    const paths = modal.getItems().map((item) => item.path);

    expect(paths).toEqual(["/", "Projects", "Projects/2024", "Archive"]);
  });

  it("labels the vault root and returns other folder paths verbatim", () => {
    const root = folder("/");
    const modal = new FolderSuggestModal(appWithRoot(root), () => {});

    expect(modal.getItemText(root)).toBe("/ (vault root)");
    expect(modal.getItemText(folder("Notes/Deep"))).toBe("Notes/Deep");
  });

  it("invokes the chosen callback when a folder is selected", () => {
    const onChoose = vi.fn();
    const target = folder("Inbox");
    const modal = new FolderSuggestModal(appWithRoot(folder("/", [target])), onChoose);

    modal.onChooseItem(target);

    expect(onChoose).toHaveBeenCalledWith(target);
  });
});
